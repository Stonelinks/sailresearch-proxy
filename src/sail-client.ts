import { config } from "./config.ts";
import { log } from "../shared/logger.ts";
import { now } from "../shared/time.ts";

// ── Retry constants ──────────────────────────────────────────────────────

/** Maximum retry attempts for transient fetch errors. */
export const MAX_RETRIES = 10;

/** Base delay in ms for the first retry. Doubles on each subsequent retry. */
export const BASE_DELAY_MS = 200;

/** Backoff multiplier applied to the delay on each retry. */
export const BACKOFF_FACTOR = 2;

/** Cap on any single retry delay to prevent excessive waits. */
export const MAX_DELAY_MS = 30_000;

// ── Transient-error detection ─────────────────────────────────────────────

/**
 * Determine whether a fetch error is transient and safe to retry.
 *
 * "Socket connection was closed unexpectedly", ECONNRESET, EPIPE, and
 * similar network-level failures mean the request never completed — the
 * server never saw it, so retrying cannot produce duplicate side-effects.
 *
 * TimeoutError is also transient: the server may still be processing, but
 * the client can safely issue a fresh request.
 *
 * HTTP error responses (4xx/5xx) are NOT transient — the request completed
 * and the server explicitly rejected it.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Bun/Node network error codes
  const code = (err as any).code;
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "ENETUNREACH" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  // Timeout from AbortSignal.timeout()
  if (err.name === "TimeoutError") return true;

  // Bun fetch socket-closed errors — the exact message varies across Bun
  // versions, but always includes "socket" or "connection" keywords.
  const msg = err.message?.toLowerCase() ?? "";
  if (
    msg.includes("socket") &&
    (msg.includes("closed") || msg.includes("reset"))
  ) {
    return true;
  }
  if (
    msg.includes("connection was closed") ||
    msg.includes("connection reset")
  ) {
    return true;
  }

  // Fetch-level TypeError from undici/Bun when the connection drops
  if (err.name === "TypeError" && msg.includes("fetch failed")) return true;

  return false;
}

// ── Core request with retry ────────────────────────────────────────────

interface RequestOptions extends RequestInit {
  /** Per-call abort timeout. Required so every call site picks an appropriate bound. */
  timeoutMs: number;
}

async function request(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; data: any }> {
  const { timeoutMs, ...init } = options;
  const method = init.method ?? "GET";
  const bodyBytes =
    typeof init.body === "string" ? init.body.length : init.body ? -1 : 0;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(
        BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
        MAX_DELAY_MS,
      );
      log.warn(
        `[sail] retry ${attempt}/${MAX_RETRIES} ${method} ${path} in ${delay}ms (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }

    log.debug(
      `[sail] → ${method} ${path} bodyBytes=${bodyBytes} attempt=${attempt}`,
    );
    const start = now();
    try {
      const res = await fetch(`${config.sail.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${config.sail.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const data: any = await res.json();
      const ms = now() - start;
      const respBytes = JSON.stringify(data).length;
      log.debug(
        `[sail] ← ${method} ${path} status=${res.status} ms=${ms} bodyBytes=${respBytes} attempt=${attempt}`,
      );
      if (res.status < 200 || res.status >= 300) {
        log.warn(
          `[sail] non-2xx ${method} ${path} status=${res.status} error=${data?.error?.message ?? "<none>"}`,
        );
      }
      return { status: res.status, data };
    } catch (err) {
      const ms = now() - start;
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      if (isTimeout) {
        log.warn(
          `[sail] timeout ${method} ${path} after ${ms}ms (limit=${timeoutMs}ms) attempt=${attempt}`,
        );
      } else {
        log.warn(
          `[sail] fetch error ${method} ${path} after ${ms}ms attempt=${attempt}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      lastError = err;
      if (!isTransientError(err)) throw err;
    }
  }

  // All retries exhausted — throw the last transient error.
  throw lastError;
}

export const sail = {
  /** Synchronous chat completion — full generation time. */
  chatCompletions(body: any) {
    return request("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: config.sail.inferenceTimeoutMs,
    });
  },

  /**
   * Create a Responses-API request. Called from two paths:
   *  - batched submit (`background: true`) — Sail returns the job id quickly;
   *    use `pollTimeoutMs`.
   *  - asap passthrough — Sail runs inference inline; use `inferenceTimeoutMs`.
   * Caller picks via `opts.timeoutMs`.
   */
  createResponse(body: any, opts: { timeoutMs: number }) {
    return request("/responses", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
    });
  },

  /** Poll job status — should be sub-second. */
  getResponse(responseId: string) {
    return request(`/responses/${responseId}`, {
      timeoutMs: config.sail.pollTimeoutMs,
    });
  },

  /** Models list — fast metadata fetch. */
  listModels() {
    return request("/models", {
      timeoutMs: config.sail.pollTimeoutMs,
    });
  },

  /** Synchronous Anthropic-format message — full generation time. */
  createMessage(body: any) {
    return request("/messages", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: config.sail.inferenceTimeoutMs,
    });
  },
};
