/**
 * Recovery for Sail chat-completion streams that end in a "superseded"
 * error. Sail's streaming "does not yet continue across a failed execution
 * attempt": when it retries an execution internally, the open SSE stream
 * gets an in-band error ("the streaming attempt was superseded; fetch the
 * completed response by id") while the generation carries on server-side.
 *
 * `recoverChatStream` wraps the upstream body and forwards every event
 * verbatim until that error appears. If nothing content-bearing has reached
 * the client yet, it polls `GET /chat/completions/{id}` and replays the
 * finished completion as synthesized `chat.completion.chunk` events — the
 * client just sees a (late) normal stream. If partial output was already
 * sent, the retried generation may not match it, so the error is passed on
 * with a clearer message naming the response id instead.
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

/** True if a chunk's delta carries anything the client would render. */
function hasContent(chunk: any): boolean {
  for (const choice of chunk?.choices ?? []) {
    const d = choice?.delta;
    if (!d) continue;
    if (typeof d.content === "string" && d.content !== "") return true;
    if (typeof d.reasoning_content === "string" && d.reasoning_content !== "")
      return true;
    if (typeof d.reasoning === "string" && d.reasoning !== "") return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return true;
  }
  return false;
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
    if (msg.reasoning_content)
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
  /** Poll delay schedule (ms); the last entry repeats. Overridable for tests. */
  pollDelaysMs?: number[];
}

type PollResult =
  | { ok: true; completion: any; polls: number }
  | { ok: false; reason: string; polls: number };

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
      return { ok: false, reason: "client disconnected", polls };
    }
    if (now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
      keepalive();
      lastKeepalive = now();
    }
    if (now() > deadline) {
      return { ok: false, reason: "timed out waiting for completion", polls };
    }
    polls++;

    let res: Response;
    try {
      const signals = [AbortSignal.timeout(config.sail.pollTimeoutMs)];
      if (opts.clientSignal) signals.push(opts.clientSignal);
      res = await fetch(`${config.sail.baseUrl}/chat/completions/${id}`, {
        headers: { Authorization: `Bearer ${config.sail.apiKey}` },
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (opts.clientSignal?.aborted) {
        return { ok: false, reason: "client disconnected", polls };
      }
      log.debug(`[${opts.logPrefix}] recovery poll ${id} failed: ${err}`);
      continue;
    }

    if (res.status === 404) {
      if (++notFound >= MAX_NOT_FOUND) {
        return { ok: false, reason: "response not found", polls };
      }
      continue;
    }
    notFound = 0;
    if (res.status === 429 || res.status >= 500) continue;
    if (!res.ok) {
      return { ok: false, reason: `retrieve returned ${res.status}`, polls };
    }

    const body: any = await res.json().catch(() => null);
    const status = body?.status;
    if (FAILED_STATUSES.has(status)) {
      const detail = body?.error?.message ? `: ${body.error.message}` : "";
      return { ok: false, reason: `response ${status}${detail}`, polls };
    }
    const done =
      status === "completed" ||
      status === "incomplete" ||
      (status === undefined && body?.choices?.[0]?.finish_reason);
    if (done && Array.isArray(body.choices)) {
      return { ok: true, completion: body, polls };
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

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      let completionId: string | undefined;
      let emittedContent = false;

      const handleSuperseded = async (ev: SseEvent, payload: any) => {
        await reader.cancel().catch(() => {});
        const id = idFromError(payload) ?? completionId;
        const started = now();

        let failure: string;
        if (!id) {
          failure = "no response id was seen";
        } else if (emittedContent) {
          failure = "partial output was already streamed";
        } else {
          log.info(
            `[${opts.logPrefix}] stream superseded; recovering response ${id} by polling`,
          );
          const result = await pollCompletion(id, opts, () =>
            send(": keepalive\n\n"),
          );
          const elapsed = Math.round((now() - started) / SECOND);
          if (result.ok) {
            log.info(
              `[${opts.logPrefix}] recovered response ${id} after ${result.polls} polls (${elapsed}s)`,
            );
            for (const c of completionToChunks(
              result.completion,
              opts.includeUsage,
            )) {
              send(sseData(c));
            }
            send("data: [DONE]\n\n");
            return finish();
          }
          failure = result.reason;
          if (opts.clientSignal?.aborted) return finish();
        }

        log.warn(
          `[${opts.logPrefix}] superseded stream not recovered (${failure}); response id=${id ?? "unknown"}`,
        );
        const message =
          `Sail superseded the streaming attempt and the proxy could not recover it ` +
          `(${failure}). Completed response id=${id ?? "unknown"}; ` +
          `upstream said: ${payload.error.message}`;
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
              if (hasContent(payload)) emittedContent = true;
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
      return reader.cancel(reason);
    },
  });
}
