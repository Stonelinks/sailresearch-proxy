import { config } from "./config.ts";
import { log } from "../shared/logger.ts";
import { now } from "../shared/time.ts";

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
  log.debug(`[sail] → ${method} ${path} bodyBytes=${bodyBytes}`);
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
      `[sail] ← ${method} ${path} status=${res.status} ms=${ms} bodyBytes=${respBytes}`,
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
        `[sail] timeout ${method} ${path} after ${ms}ms (limit=${timeoutMs}ms)`,
      );
    }
    throw err;
  }
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
