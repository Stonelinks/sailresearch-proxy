/**
 * Recovery for Sail chat-completion streams that end in a "superseded"
 * error. Sail's streaming "does not yet continue across a failed execution
 * attempt": when it retries an execution internally, the open SSE stream
 * gets an in-band error ("the streaming attempt was superseded; fetch the
 * completed response by id") while the generation carries on server-side —
 * or, in practice, sometimes fails outright.
 *
 * `recoverChatStream` wraps the upstream body and forwards every event
 * verbatim until that error appears. Then:
 *
 *   - If no answer text or tool call has reached the client yet (reasoning
 *     alone doesn't count), it polls `GET /chat/completions/{id}`:
 *       - completed → replays the result as synthesized
 *         `chat.completion.chunk` events (skipping reasoning if some was
 *         already streamed), so the client just sees a late normal stream;
 *       - failed → re-issues the request once via `opts.retry` and relays
 *         the fresh stream (itself recoverable, but not retried again).
 *   - If answer output was already sent, the retried generation may not
 *     match it, so the error is passed on with a clearer message carrying
 *     the response id and Sail's reported status.
 */
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { SECOND, now } from "../../shared/time.ts";

const SUPERSEDED_RE = /supersed/i;
const RESPONSE_ID_RE = /\b(resp_[0-9a-zA-Z-]+|chatcmpl-[0-9a-zA-Z-]+)/;
const EVENT_END_RE = /\r?\n\r?\n/;

/** Statuses after which polling stops without a usable completion. */
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "expired"]);
/** Consecutive 404s tolerated before giving up on the id. */
const MAX_NOT_FOUND = 5;
const KEEPALIVE_INTERVAL_MS = 15 * SECOND;

export interface SseEvent {
  /** The event exactly as received, including its trailing blank line. */
  raw: string;
  /** Value of the `event:` field, if any. */
  event?: string;
  /** `data:` lines joined with "\n", or undefined for comment-only events. */
  data?: string;
}

/**
 * Split buffered SSE text into complete events. Returns the parsed events and
 * the unconsumed remainder (a partial event awaiting more bytes).
 */
export function parseSseEvents(buffer: string): {
  events: SseEvent[];
  rest: string;
} {
  const events: SseEvent[] = [];
  let rest = buffer;
  for (;;) {
    const m = EVENT_END_RE.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    const raw = rest.slice(0, end);
    rest = rest.slice(end);
    const ev: SseEvent = { raw };
    const dataLines: string[] = [];
    for (const line of raw.slice(0, m.index).split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
    }
    if (dataLines.length > 0) ev.data = dataLines.join("\n");
    events.push(ev);
  }
  return { events, rest };
}

const nonEmpty = (v: unknown) => typeof v === "string" && v !== "";

/** Classify what a chunk's deltas would show the client. */
function deltaKinds(chunk: any): { answer: boolean; reasoning: boolean } {
  let answer = false;
  let reasoning = false;
  for (const choice of chunk?.choices ?? []) {
    const d = choice?.delta;
    if (!d) continue;
    if (nonEmpty(d.content)) answer = true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) answer = true;
    if (nonEmpty(d.reasoning_content) || nonEmpty(d.reasoning))
      reasoning = true;
  }
  return { answer, reasoning };
}

/** Find a response id in a superseded error payload, if Sail included one. */
function idFromError(payload: any): string | undefined {
  const err = payload?.error ?? {};
  for (const v of [err.response_id, err.id, payload?.response_id, payload?.id])
    if (typeof v === "string" && v) return v;
  const m = typeof err.message === "string" && RESPONSE_ID_RE.exec(err.message);
  return m ? m[1] : undefined;
}

/**
 * Convert a completed `chat.completion` into the chunk sequence a streaming
 * request would have produced: role, reasoning, content, one chunk per tool
 * call, a finish chunk, and (when requested) a trailing usage chunk.
 */
export function completionToChunks(
  completion: any,
  includeUsage: boolean,
  omitReasoning = false,
): Record<string, any>[] {
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const chunk = (index: number, delta: any, finish_reason: any = null) => ({
    ...base,
    choices: [{ index, delta, finish_reason }],
  });
  const out: Record<string, any>[] = [];
  for (const choice of completion.choices ?? []) {
    const index = choice.index ?? 0;
    const msg = choice.message ?? {};
    out.push(chunk(index, { role: msg.role ?? "assistant", content: "" }));
    if (msg.reasoning_content && !omitReasoning)
      out.push(chunk(index, { reasoning_content: msg.reasoning_content }));
    if (msg.content) out.push(chunk(index, { content: msg.content }));
    (msg.tool_calls ?? []).forEach((tc: any, i: number) => {
      out.push(chunk(index, { tool_calls: [{ index: i, ...tc }] }));
    });
    out.push(chunk(index, {}, choice.finish_reason ?? "stop"));
  }
  if (includeUsage && completion.usage) {
    out.push({ ...base, choices: [], usage: completion.usage });
  }
  return out;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Sleep that resolves early (returning false) if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RecoverOpts {
  clientSignal?: AbortSignal;
  /** Mirror `stream_options.include_usage` in the synthesized stream. */
  includeUsage: boolean;
  logPrefix: string;
  /**
   * Re-issue the original request. Called at most once, and only after Sail
   * reports the superseded response as failed with no answer yet streamed.
   */
  retry?: () => Promise<Response>;
  /** Poll delay schedule (ms); the last entry repeats. Overridable for tests. */
  pollDelaysMs?: number[];
}

/** One GET of the response; null on network failure. */
async function fetchResponse(
  id: string,
  opts: RecoverOpts,
): Promise<{ status: number; body: any } | null> {
  const signals = [AbortSignal.timeout(config.sail.pollTimeoutMs)];
  if (opts.clientSignal) signals.push(opts.clientSignal);
  try {
    const res = await fetch(`${config.sail.baseUrl}/chat/completions/${id}`, {
      headers: { Authorization: `Bearer ${config.sail.apiKey}` },
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    log.debug(`[${opts.logPrefix}] fetch response ${id} failed: ${err}`);
    return null;
  }
}

/** "status=failed (chat completion failed)"-style summary of a response. */
function describe(body: any): string {
  const status = body?.status ?? "unknown";
  const detail = body?.error?.message ? ` (${body.error.message})` : "";
  return `status=${status}${detail}`;
}

type PollResult =
  | { kind: "completed"; completion: any; polls: number }
  | { kind: "failed"; body: any; polls: number }
  | { kind: "gave_up"; reason: string; polls: number };

async function pollCompletion(
  id: string,
  opts: RecoverOpts,
  keepalive: () => void,
): Promise<PollResult> {
  const delays = opts.pollDelaysMs ?? [1, 2, 3, 5].map((s) => s * SECOND);
  const deadline = now() + config.sail.recoveryTimeoutMs;
  let lastKeepalive = now();
  let notFound = 0;
  for (let polls = 0; ; ) {
    const delay = delays[Math.min(polls, delays.length - 1)]!;
    if (!(await sleep(delay, opts.clientSignal))) {
      return { kind: "gave_up", reason: "client disconnected", polls };
    }
    if (now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
      keepalive();
      lastKeepalive = now();
    }
    if (now() > deadline) {
      return { kind: "gave_up", reason: "timed out polling", polls };
    }
    polls++;

    const res = await fetchResponse(id, opts);
    if (opts.clientSignal?.aborted) {
      return { kind: "gave_up", reason: "client disconnected", polls };
    }
    if (!res) continue;
    if (res.status === 404) {
      if (++notFound >= MAX_NOT_FOUND) {
        return { kind: "gave_up", reason: "response not found", polls };
      }
      continue;
    }
    notFound = 0;
    if (res.status === 429 || res.status >= 500) continue;
    if (res.status >= 400) {
      return {
        kind: "gave_up",
        reason: `retrieve returned HTTP ${res.status}`,
        polls,
      };
    }

    const body = res.body;
    const status = body?.status;
    if (FAILED_STATUSES.has(status)) return { kind: "failed", body, polls };
    const done =
      status === "completed" ||
      status === "incomplete" ||
      (status === undefined && body?.choices?.[0]?.finish_reason);
    if (done && Array.isArray(body.choices)) {
      return { kind: "completed", completion: body, polls };
    }
  }
}

/**
 * Wrap a Sail chat-completion SSE body, recovering from a superseded
 * streaming attempt when it is safe to do so (see module comment).
 */
export function recoverChatStream(
  upstream: ReadableStream<Uint8Array>,
  opts: RecoverOpts,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let closed = false;
  let retryReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sendBytes = (bytes: Uint8Array) => {
        if (!closed) controller.enqueue(bytes);
      };
      const send = (text: string) => sendBytes(encoder.encode(text));
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      let completionId: string | undefined;
      let emittedAnswer = false;
      let emittedReasoning = false;

      /**
       * Re-issue the request and relay its stream. Returns null on success
       * (stream fully relayed) or a failure description.
       */
      const relayRetry = async (): Promise<string | null> => {
        let res: Response;
        try {
          res = await opts.retry!();
        } catch (err) {
          return `retry request failed: ${err instanceof Error ? err.message : err}`;
        }
        const isSse = res.headers
          .get("content-type")
          ?.startsWith("text/event-stream");
        if (!res.ok || !res.body || !isSse) {
          await res.body?.cancel().catch(() => {});
          return `retry returned HTTP ${res.status}`;
        }
        retryReader = recoverChatStream(res.body, {
          ...opts,
          retry: undefined,
        }).getReader();
        for (;;) {
          const { done, value } = await retryReader.read();
          if (done) return null;
          sendBytes(value);
        }
      };

      const handleSuperseded = async (ev: SseEvent, payload: any) => {
        await reader.cancel().catch(() => {});
        const id = idFromError(payload) ?? completionId;
        const started = now();

        let failure: string;
        if (!id) {
          failure = "no response id was seen";
        } else if (emittedAnswer) {
          const res = await fetchResponse(id, opts);
          const state = res ? describe(res.body) : "status=unknown";
          failure = `partial output was already streamed; Sail reports response ${id} ${state}`;
        } else {
          log.info(
            `[${opts.logPrefix}] stream superseded; recovering response ${id} by polling`,
          );
          const result = await pollCompletion(id, opts, () =>
            send(": keepalive\n\n"),
          );
          const elapsed = Math.round((now() - started) / SECOND);
          if (result.kind === "completed") {
            log.info(
              `[${opts.logPrefix}] recovered response ${id} after ${result.polls} polls (${elapsed}s)`,
            );
            for (const c of completionToChunks(
              result.completion,
              opts.includeUsage,
              emittedReasoning,
            )) {
              send(sseData(c));
            }
            send("data: [DONE]\n\n");
            return finish();
          }
          if (result.kind === "failed") {
            failure = `Sail reports response ${id} ${describe(result.body)}`;
            if (opts.retry) {
              log.warn(
                `[${opts.logPrefix}] ${failure}; retrying the request once`,
              );
              const retryFailure = await relayRetry();
              if (retryFailure === null) {
                log.info(`[${opts.logPrefix}] retry for ${id} relayed`);
                return finish();
              }
              failure += `; ${retryFailure}`;
            }
          } else {
            failure = `${result.reason} for response ${id}`;
          }
          if (opts.clientSignal?.aborted) return finish();
        }

        log.warn(
          `[${opts.logPrefix}] superseded stream not recovered: ${failure}`,
        );
        const message =
          `Sail superseded the streaming attempt and the proxy could not recover it: ` +
          `${failure}. Upstream said: ${payload.error.message}`;
        const rewritten = { ...payload, error: { ...payload.error, message } };
        send((ev.event ? `event: ${ev.event}\n` : "") + sseData(rewritten));
        send("data: [DONE]\n\n");
        finish();
      };

      const pump = async () => {
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSseEvents(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            if (ev.data && ev.data !== "[DONE]") {
              let payload: any;
              try {
                payload = JSON.parse(ev.data);
              } catch {
                payload = undefined;
              }
              if (
                payload?.error &&
                SUPERSEDED_RE.test(String(payload.error.message ?? ""))
              ) {
                return handleSuperseded(ev, payload);
              }
              if (typeof payload?.id === "string") completionId = payload.id;
              const kinds = deltaKinds(payload);
              if (kinds.answer) emittedAnswer = true;
              if (kinds.reasoning) emittedReasoning = true;
            }
            send(ev.raw);
          }
        }
        buf += decoder.decode();
        if (buf) send(buf);
        finish();
      };

      pump().catch((err) => {
        if (closed) return;
        log.warn(`[${opts.logPrefix}] stream relay failed: ${err}`);
        closed = true;
        controller.error(err);
      });
    },
    cancel(reason) {
      closed = true;
      retryReader?.cancel(reason).catch(() => {});
      return reader.cancel(reason);
    },
  });
}
