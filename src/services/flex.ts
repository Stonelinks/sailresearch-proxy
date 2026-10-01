/**
 * Flex-window emulation for synchronous clients.
 *
 * Sail serves `flex` only for background Responses requests (or Batch work):
 * a synchronous Chat Completions or foreground Responses call on flex gets
 * 400 `completion_window "flex" is only available for background responses`.
 * Clients that can only make synchronous calls (pi, the finance app) still
 * want flex pricing, so for those requests the proxy submits a
 * `background: true` Responses job, polls `GET /responses/{id}` until it is
 * terminal, and answers in the shape the client asked for — JSON, or SSE
 * with comment heartbeats while the job is queued.
 *
 * This is the pre-2f95450 batching path, cut down to an in-memory poll per
 * request: no job table, dedup cache, or dashboard. A client disconnect
 * stops the polling (Sail has no cancel endpoint, so the job runs to
 * completion and is billed regardless).
 */
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { now, formatDuration } from "../../shared/time.ts";
import { mapSailError, openAIError } from "../errors.ts";
import {
  chatToResponsesBody,
  completionToChunks,
  responsesToChatCompletion,
} from "../transforms/chat-responses.ts";

/** Poll delay by poll count: quick at first, then backing off to a floor. */
export function pollDelayMs(pollCount: number): number {
  if (pollCount < 3) return 2_000;
  if (pollCount < 6) return 5_000;
  if (pollCount < 21) return 10_000;
  return 30_000;
}

const HEARTBEAT_MS = 15_000;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

const TERMINAL = new Set(["completed", "incomplete", "failed", "cancelled"]);

export type FlexResult =
  | { ok: true; data: any }
  | { ok: false; status: number; type: string; message: string };

export interface FlexOpts {
  clientSignal?: AbortSignal;
  logPrefix: string;
  /** Test seam: replaces `pollDelayMs`. */
  delayMs?: (pollCount: number) => number;
  /** Test seam: replaces the flex window timeout. */
  timeoutMs?: number;
}

/**
 * Submit a background Responses job. Returns the accepted job, or the
 * upstream error as a ready-to-send Response (Sail's error bodies are
 * already OpenAI-shaped). Not retried: a retry could double-bill.
 */
async function submit(
  body: any,
  opts: FlexOpts,
): Promise<{ job: any } | { error: Response }> {
  let res: Response;
  try {
    res = await fetch(`${config.sail.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.sail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.clientSignal
        ? AbortSignal.any([
            opts.clientSignal,
            AbortSignal.timeout(config.sail.pollTimeoutMs),
          ])
        : AbortSignal.timeout(config.sail.pollTimeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[${opts.logPrefix}] flex submit failed: ${message}`);
    return {
      error: openAIError(
        502,
        `Sail flex submit failed: ${message}`,
        "upstream_error",
      ),
    };
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 202) {
    log.warn(
      `[${opts.logPrefix}] flex submit rejected status=${res.status} error=${data?.error?.message ?? "<none>"}`,
    );
    return { error: mapSailError(res.status, data) };
  }
  log.info(
    `[${opts.logPrefix}] flex submitted id=${data?.id} model=${body.model} status=${data?.status}`,
  );
  return { job: data };
}

/**
 * Fetch a job's current state. Polled directly rather than through
 * sail-client: the poll loop is itself the retry, so a transient failure
 * just waits for the next tick.
 */
async function getResponse(id: string): Promise<{ status: number; data: any }> {
  const res = await fetch(
    `${config.sail.baseUrl}/responses/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${config.sail.apiKey}` },
      signal: AbortSignal.timeout(config.sail.pollTimeoutMs),
    },
  );
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Poll a submitted job until it is terminal, times out, or the client leaves. */
async function waitForJob(job: any, opts: FlexOpts): Promise<FlexResult> {
  const id = job.id;
  const start = now();
  const timeoutMs = opts.timeoutMs ?? config.windowTimeouts.flex;
  const delay = opts.delayMs ?? pollDelayMs;
  let current = job;

  for (let polls = 0; !TERMINAL.has(current?.status); polls++) {
    if (now() - start >= timeoutMs) {
      log.warn(`[${opts.logPrefix}] flex timeout id=${id} ms=${timeoutMs}`);
      return {
        ok: false,
        status: 504,
        type: "timeout_error",
        message: `Flex job ${id} did not finish within ${formatDuration(timeoutMs)}; it may still complete on Sail.`,
      };
    }
    await sleep(delay(polls), opts.clientSignal);
    if (opts.clientSignal?.aborted) {
      log.info(
        `[${opts.logPrefix}] client disconnected; stopped polling flex id=${id}`,
      );
      return {
        ok: false,
        status: 499,
        type: "client_closed",
        message: "Client disconnected",
      };
    }
    try {
      const { status, data } = await getResponse(id);
      if (status === 200) {
        current = data;
      } else if (status >= 400 && status < 500 && status !== 429) {
        log.warn(
          `[${opts.logPrefix}] flex poll id=${id} status=${status}: ${data?.error?.message ?? "<none>"}`,
        );
        return {
          ok: false,
          status: 502,
          type: "upstream_error",
          message: `Polling flex job ${id} failed (${status}): ${data?.error?.message ?? "unknown error"}`,
        };
      }
    } catch (err) {
      // Network blip or timeout: try again on the next tick.
      log.warn(`[${opts.logPrefix}] flex poll id=${id} error: ${err}`);
    }
  }

  const waited = formatDuration(now() - start);
  if (current.status === "failed" || current.status === "cancelled") {
    const message =
      current.error?.message ?? `Sail flex job ${id} ${current.status}`;
    log.warn(
      `[${opts.logPrefix}] flex ${current.status} id=${id} after ${waited}: ${message}`,
    );
    return { ok: false, status: 502, type: "upstream_error", message };
  }
  log.info(
    `[${opts.logPrefix}] flex ${current.status} id=${id} model=${current.model} after ${waited}`,
  );
  return { ok: true, data: current };
}

/**
 * Wrap a pending result in an SSE stream: comment heartbeats while waiting,
 * then whatever `render` emits. A failure becomes an in-band `error` event,
 * which OpenAI-compatible SDKs raise as an API error.
 */
function heartbeatSSE(
  result: Promise<FlexResult>,
  render: (data: any) => string[],
  abort: AbortController,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          // Stream already closed by the client.
        }
      };
      timer = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      const r = await result;
      clearInterval(timer);
      if (r.ok) {
        for (const event of render(r.data)) send(event);
      } else if (r.type !== "client_closed") {
        send(
          `data: ${JSON.stringify({ error: { message: r.message, type: r.type, code: null } })}\n\n`,
        );
      }
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    },
    cancel() {
      clearInterval(timer);
      abort.abort();
    },
  });
}

function errorResponse(r: Extract<FlexResult, { ok: false }>): Response {
  return openAIError(r.status, r.message, r.type);
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** Serve a chat-completions request on flex via a background Responses job. */
export async function chatCompletionViaFlex(
  body: any,
  opts: FlexOpts,
): Promise<Response> {
  const submitted = await submit(chatToResponsesBody(body, "flex"), opts);
  if ("error" in submitted) return submitted.error;

  if (body.stream !== true) {
    const r = await waitForJob(submitted.job, opts);
    return r.ok
      ? Response.json(responsesToChatCompletion(r.data))
      : errorResponse(r);
  }

  const abort = new AbortController();
  const signal = opts.clientSignal
    ? AbortSignal.any([opts.clientSignal, abort.signal])
    : abort.signal;
  const includeUsage = body.stream_options?.include_usage === true;
  const stream = heartbeatSSE(
    waitForJob(submitted.job, { ...opts, clientSignal: signal }),
    (data) => [
      ...completionToChunks(responsesToChatCompletion(data), includeUsage).map(
        sse,
      ),
      "data: [DONE]\n\n",
    ],
    abort,
  );
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Serve a foreground Responses request on flex by running it in the
 * background and replaying the result. Already-background requests are not
 * routed here — they pass straight through.
 */
export async function responseViaFlex(
  body: any,
  opts: FlexOpts,
): Promise<Response> {
  const { stream, ...rest } = body;
  const submitted = await submit(
    {
      ...rest,
      background: true,
      store: true,
      metadata: { ...body.metadata, completion_window: "flex" },
    },
    opts,
  );
  if ("error" in submitted) return submitted.error;

  if (stream !== true) {
    const r = await waitForJob(submitted.job, opts);
    return r.ok ? Response.json(r.data) : errorResponse(r);
  }

  const abort = new AbortController();
  const signal = opts.clientSignal
    ? AbortSignal.any([opts.clientSignal, abort.signal])
    : abort.signal;
  return new Response(
    heartbeatSSE(
      waitForJob(submitted.job, { ...opts, clientSignal: signal }),
      synthesizeResponsesEvents,
      abort,
    ),
    { headers: SSE_HEADERS },
  );
}

/**
 * Replay a finished Responses object as the Responses streaming event
 * sequence (created → per-item added/delta/done → completed). Text goes out
 * as one delta per part since Sail returns it all at once.
 */
export function synthesizeResponsesEvents(resp: any): string[] {
  const events: string[] = [];
  let seq = 0;
  const emit = (payload: any) =>
    events.push(
      `event: ${payload.type}\n` + sse({ ...payload, sequence_number: seq++ }),
    );

  emit({
    type: "response.created",
    response: { ...resp, status: "in_progress", output: [] },
  });
  const output: any[] = Array.isArray(resp.output) ? resp.output : [];
  output.forEach((item, output_index) => {
    emit({
      type: "response.output_item.added",
      output_index,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message" ? { content: [] } : {}),
      },
    });
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((part: any, content_index: number) => {
        emit({
          type: "response.content_part.added",
          item_id: item.id,
          output_index,
          content_index,
          part: { ...part, text: "" },
        });
        if (part.type === "output_text" && part.text) {
          emit({
            type: "response.output_text.delta",
            item_id: item.id,
            output_index,
            content_index,
            delta: part.text,
          });
          emit({
            type: "response.output_text.done",
            item_id: item.id,
            output_index,
            content_index,
            text: part.text,
          });
        }
        emit({
          type: "response.content_part.done",
          item_id: item.id,
          output_index,
          content_index,
          part,
        });
      });
    }
    emit({ type: "response.output_item.done", output_index, item });
  });
  emit({
    type:
      resp.status === "incomplete"
        ? "response.incomplete"
        : "response.completed",
    response: resp,
  });
  return events;
}
