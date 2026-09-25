/**
 * Thin forwarder to Sail's native API. The proxy's only remaining inference
 * job: resolve the completion window (URL prefix > header > body metadata >
 * default), inject it as `metadata.completion_window`, and pass the request
 * through verbatim — Sail handles all windows natively on its synchronous
 * endpoints, including SSE streaming.
 *
 * No retries: these are non-idempotent, potentially minutes-long inference
 * requests; a retry could double-bill a generation. No proxy-side timeout:
 * the client's own disconnect (via `clientSignal`) aborts the upstream call.
 */
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import type { CompletionWindow } from "../types.ts";

export type SailPath = "/chat/completions" | "/messages" | "/responses";
export type ErrorFormat = "openai" | "anthropic";

/**
 * Fields Sail's endpoints still reject with a 400 (verified against the
 * live API, 2026-07). Everything else — including `system`, `tools`,
 * `thinking`, `stream`, `stream_options`, `max_tokens`, `prompt_cache_key` —
 * is now natively supported and must be forwarded untouched.
 */
const MESSAGES_DROP_FIELDS = [
  "top_k",
  "stop_sequences",
  "service_tier",
  "inference_geo",
] as const;

/** Hop-by-hop / body-encoding headers that must not be replayed to the
 *  client: Bun's fetch transparently decompresses, so the upstream
 *  content-length/encoding no longer describe the bytes we send. */
const DROP_RESPONSE_HEADERS = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
];

export function normalizeBody(
  path: SailPath,
  body: Record<string, any>,
  window: CompletionWindow,
): Record<string, any> {
  const out: Record<string, any> = {
    ...body,
    metadata: { ...body.metadata, completion_window: window },
  };
  if (path === "/chat/completions") {
    // Sail rejects store=false ("responses are always stored"); store=true
    // is accepted, so only the false case needs dropping.
    if (out.store === false) delete out.store;
  }
  if (path === "/messages") {
    for (const f of MESSAGES_DROP_FIELDS) delete out[f];
  }
  return out;
}

function upstreamFailure(format: ErrorFormat, message: string): Response {
  if (format === "anthropic") {
    return Response.json(
      { type: "error", error: { type: "api_error", message } },
      { status: 502 },
    );
  }
  return Response.json(
    {
      error: {
        message,
        type: "upstream_error",
        param: null,
        code: null,
      },
    },
    { status: 502 },
  );
}

export async function forwardToSail(opts: {
  path: SailPath;
  body: Record<string, any>;
  window: CompletionWindow;
  clientSignal?: AbortSignal;
  errorFormat: ErrorFormat;
  logPrefix: string;
}): Promise<Response> {
  const sailBody = normalizeBody(opts.path, opts.body, opts.window);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.sail.baseUrl}${opts.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.sail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sailBody),
      signal: opts.clientSignal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[${opts.logPrefix}] sail fetch failed: ${message}`);
    return upstreamFailure(opts.errorFormat, `Sail request failed: ${message}`);
  }

  log.debug(
    `[${opts.logPrefix}] sail status=${upstream.status} window=${opts.window}`,
  );

  const headers = new Headers(upstream.headers);
  for (const h of DROP_RESPONSE_HEADERS) headers.delete(h);

  // Pass body, status, and remaining headers through verbatim — SSE streams
  // flow chunk-by-chunk, and Sail's error bodies (already shaped per API
  // surface) reach the client unmodified.
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
