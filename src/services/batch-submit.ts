import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { now, formatDuration } from "../../shared/time.ts";
import { openAIError, mapSailError } from "../errors.ts";
import { computeSailBodyHash, findExistingJob } from "../dedup.ts";
import { PERIODIC_RECHECK_MS } from "../constants.ts";
import type { Poller, WaiterRegistration } from "./poller.ts";
import type { CompletionWindow } from "../types.ts";
import { mapSailStatus } from "../types.ts";
import type { PrismaClient } from "@prisma/client";

/**
 * Error format used by the batch-submit module.
 * Callers translate these into API-format responses appropriate for their surface.
 */
export interface BatchError {
  type: "timeout" | "upstream" | "sail_api";
  status: number;
  message: string;
  sailBody?: any;
}

/**
 * Result of a batch submission — either a successful Sail response object,
 * or a structured error for the caller to format.
 */
export type BatchResult =
  | { ok: true; data: any }
  | { ok: false; error: BatchError };

export interface SubmitAndWaitParams {
  /** The exact body that will be sent to Sail's /v1/responses endpoint. */
  sailBody: any;
  /** Completion window for this request. */
  completionWindow: CompletionWindow;
  /** API surface type for dashboard tracking. */
  apiType: "chat-completions" | "messages" | "responses";
  /** The original request body (for dashboard/debugging, persisted as requestBody). */
  originalRequestBody: any;
  /** Model name (for dashboard). */
  model: string;
  /** Poller instance for registering waiters. */
  poller: Poller;
  /** Prisma client. */
  db: PrismaClient;
  /** Log prefix for disambiguation (e.g. "batch", "batch-messages", "batch-responses"). */
  logPrefix?: string;
}

/**
 * Dedup-aware batch submit + wait.
 *
 * 1. Hash the sailBody and check for an existing non-failed/non-cancelled job.
 * 2. If a completed job exists, return its cached result immediately (no Sail call).
 * 3. If an in-flight job exists, register a waiter on its sailResponseId (no Sail call).
 * 4. Otherwise, submit to Sail, persist with sailBodyHash, register waiter, race timeout.
 *
 * Returns the raw Sail Responses API result (or a BatchError).
 * The caller is responsible for transforming the result into the appropriate
 * API format (chat-completion, Anthropic message, or pass-through).
 */
export async function submitAndWait(
  params: SubmitAndWaitParams,
): Promise<BatchResult> {
  const {
    sailBody,
    completionWindow,
    apiType,
    originalRequestBody,
    model,
    poller,
    db,
    logPrefix = "batch",
  } = params;

  const hash = computeSailBodyHash(sailBody);
  log.debug(`[${logPrefix}] sailBodyHash=${hash}`);

  // ── Dedup lookup ──────────────────────────────────────────────────────
  const existing = await findExistingJob(db, hash);
  if (existing) {
    const existingAge = existing.createdAt
      ? formatDuration(now() - new Date(existing.createdAt).getTime())
      : "unknown";
    if (existing.status === "completed" && existing.responseBody) {
      log.info(
        `[${logPrefix}] dedup hit: completed job id=${existing.sailResponseId} model=${model} window=${completionWindow} age=${existingAge} hash=${hash.slice(0, 12)}`,
      );
      const cachedData = JSON.parse(existing.responseBody);
      return { ok: true, data: cachedData };
    }

    // Defensive: a row marked completed without a body should never exist
    // (the poller writes both atomically), but if it does, latching onto it
    // would hang forever — the poller won't re-process a completed row. Fall
    // through to a fresh submit instead.
    if (existing.status === "completed" && !existing.responseBody) {
      log.warn(
        `[${logPrefix}] dedup skip: completed job has no responseBody, submitting fresh id=${existing.sailResponseId}`,
      );
    } else {
      // In-flight job — latch onto it
      log.info(
        `[${logPrefix}] dedup hit: in-flight job id=${existing.sailResponseId} model=${model} window=${completionWindow} status=${existing.status} pending=${existingAge} hash=${hash.slice(0, 12)}`,
      );
      return latchOntoExistingJob(
        existing.sailResponseId,
        completionWindow,
        poller,
        db,
        logPrefix,
      );
    }
  }

  // ── No match — submit to Sail ─────────────────────────────────────────
  log.debug(
    `[${logPrefix}] submitting to Sail keys=${Object.keys(sailBody).join(",")}`,
  );
  // Batch submit with `background: true` — Sail returns the job id quickly,
  // actual generation is polled separately.
  let status: number;
  let data: any;
  try {
    ({ status, data } = await sail.createResponse(sailBody, {
      timeoutMs: config.sail.pollTimeoutMs,
    }));
  } catch (err) {
    // Network / abort / timeout — fail the request cleanly instead of
    // letting it bubble up as an unhandled 500.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[${logPrefix}] sail submit failed: ${isTimeout ? "timeout" : "network"} ${message}`,
    );
    return {
      ok: false,
      error: {
        type: "upstream",
        status: 502,
        message: `Sail submit failed: ${message}`,
      },
    };
  }
  log.debug(
    `[${logPrefix}] sail submit status=${status} id=${data?.id} sailStatus=${data?.status}`,
  );

  if (status !== 200 && status !== 202) {
    return {
      ok: false,
      error: {
        type: "sail_api",
        status: status >= 500 ? 502 : status,
        message:
          data?.error?.message || data?.message || `Sail API error: ${status}`,
        sailBody: data,
      },
    };
  }

  // Synchronous completion (unlikely but possible)
  if (data.status === "completed") {
    log.info(
      `[${logPrefix}] sail returned completed synchronously id=${data.id} model=${model} window=${completionWindow}`,
    );
    return { ok: true, data };
  }

  const sailResponseId = data.id;

  // Persist to DB
  await db.pendingJob.create({
    data: {
      sailResponseId,
      // Map Sail's "in_progress" to our "running" enum value
      status: mapSailStatus(data.status ?? "pending"),
      requestBody: JSON.stringify(originalRequestBody),
      model,
      completionWindow,
      apiType,
      sailBodyHash: hash,
    },
  });
  log.info(
    `[${logPrefix}] submitted fresh id=${sailResponseId} model=${model} window=${completionWindow} sailStatus=${data.status ?? "pending"} hash=${hash.slice(0, 12)}`,
  );

  // Wait for the job to complete. latchOntoExistingJob handles the
  // register-then-recheck race window: between the create above and our
  // registerWaiter call, the poller can complete the job and clear its waiter
  // Set. The recheck inside latch catches that case.
  return latchOntoExistingJob(
    sailResponseId,
    completionWindow,
    poller,
    db,
    logPrefix,
  );
}

/**
 * Register a waiter on an in-flight job and race against the window timeout.
 *
 * Exported for direct testing of the timer-cleanup contract — production
 * callers should go through `submitAndWait`.
 */
export async function waitForJob(
  sailResponseId: string,
  completionWindow: CompletionWindow,
  poller: Poller,
  logPrefix: string,
): Promise<BatchResult> {
  // submitAndWait routes asap to passthrough before this is reached, so the
  // window here must be one of the polled windows. Type-narrow explicitly so
  // getTimeoutMs's stricter signature is satisfied.
  if (completionWindow === "asap") {
    throw new Error("waitForJob called with asap window — caller bug");
  }
  const reg = poller.registerWaiter(sailResponseId);
  return raceWaiterAgainstTimeout(
    reg,
    completionWindow,
    sailResponseId,
    logPrefix,
  );
}

/**
 * Register a waiter on `sailResponseId`, then re-read the row to close the
 * register-after-event race: if the poller settled the job *before* the
 * register call (e.g. between `db.create` and here on the fresh-submit path,
 * or between `findExistingJob` and here on the dedup-hit path), the waiter
 * lands in an empty Set and would otherwise hang to the window timeout. The
 * recheck catches that — registration is synchronous, so any settle that
 * happens *after* it goes through the registered waiter normally.
 */

async function latchOntoExistingJob(
  sailResponseId: string,
  completionWindow: CompletionWindow,
  poller: Poller,
  db: PrismaClient,
  logPrefix: string,
): Promise<BatchResult> {
  if (completionWindow === "asap") {
    throw new Error(
      "latchOntoExistingJob called with asap window — caller bug",
    );
  }
  const reg = poller.registerWaiter(sailResponseId);

  const row = await db.pendingJob.findUnique({
    where: { sailResponseId },
    select: { status: true, responseBody: true, errorBody: true },
  });

  log.info(
    `[${logPrefix}] latch: id=${sailResponseId} recheckStatus=${row?.status ?? "<missing>"} hasResponseBody=${!!row?.responseBody}`,
  );

  if (row?.status === "completed" && row.responseBody) {
    log.info(
      `[${logPrefix}] race-recheck: job already completed id=${sailResponseId}`,
    );
    reg.cancel();
    return { ok: true, data: JSON.parse(row.responseBody) };
  }

  if (row?.status === "failed" || row?.status === "cancelled") {
    log.info(
      `[${logPrefix}] race-recheck: job already ${row.status} id=${sailResponseId}`,
    );
    reg.cancel();
    const parsed = row.errorBody ? safeParseJson(row.errorBody) : null;
    return {
      ok: false,
      error: {
        type: "upstream",
        status: 502,
        message:
          parsed?.error?.message || `Sail request ${sailResponseId} failed`,
      },
    };
  }

  return raceWaiterAgainstTimeoutWithRecheck(
    reg,
    completionWindow,
    sailResponseId,
    db,
    logPrefix,
  );
}

/**
 * Like raceWaiterAgainstTimeout, but also polls the DB every PERIODIC_RECHECK_MS
 * as a safety net. If the registered waiter is somehow not notified when the
 * poller settles the job (we've seen this in production: rows updated to
 * completed in DB without the corresponding waiter resolving), the periodic
 * recheck rescues the request within ~5s instead of hanging to the window
 * timeout. The waiter remains the fast path.
 */
async function raceWaiterAgainstTimeoutWithRecheck(
  reg: WaiterRegistration,
  completionWindow: Exclude<CompletionWindow, "asap">,
  sailResponseId: string,
  db: PrismaClient,
  logPrefix: string,
): Promise<BatchResult> {
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[${logPrefix}] waiter registered (with recheck) id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
  );

  const resultPromise = reg.promise
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ ok: false; error: "timeout" }>(
    (resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        timeoutMs,
      );
    },
  );

  const stop = { value: false };
  const recheckPromise = (async (): Promise<
    { ok: true; result: any } | { ok: false; error: any } | null
  > => {
    while (!stop.value) {
      await new Promise<void>((r) => setTimeout(r, PERIODIC_RECHECK_MS));
      if (stop.value) return null;
      try {
        const row = await db.pendingJob.findUnique({
          where: { sailResponseId },
          select: { status: true, responseBody: true, errorBody: true },
        });
        if (row?.status === "completed" && row.responseBody) {
          log.warn(
            `[${logPrefix}] periodic-recheck rescued completion id=${sailResponseId} (waiter was not resolved)`,
          );
          return { ok: true, result: JSON.parse(row.responseBody) };
        }
        if (row?.status === "failed" || row?.status === "cancelled") {
          log.warn(
            `[${logPrefix}] periodic-recheck rescued ${row.status} id=${sailResponseId} (waiter was not rejected)`,
          );
          const parsed = row.errorBody ? safeParseJson(row.errorBody) : null;
          return {
            ok: false,
            error: parsed ?? {
              error: { message: `Sail request ${sailResponseId} failed` },
            },
          };
        }
      } catch (err) {
        log.debug(
          `[${logPrefix}] periodic-recheck DB error id=${sailResponseId}: ${err}`,
        );
      }
    }
    return null;
  })();

  let outcome: { ok: true; result: any } | { ok: false; error: any };
  try {
    const winner = await Promise.race([
      resultPromise,
      timeoutPromise,
      recheckPromise,
    ]);
    if (winner === null) {
      // recheckPromise returned null — only possible if `stop` was set, which
      // only happens in finally, after race resolved. Defensive.
      throw new Error(
        "unreachable: recheck returned null before race resolved",
      );
    }
    outcome = winner;
  } finally {
    stop.value = true;
    if (timer) clearTimeout(timer);
    reg.cancel();
  }

  log.debug(`[${logPrefix}] outcome id=${sailResponseId} ok=${outcome.ok}`);

  if (!outcome.ok) {
    if (outcome.error === "timeout") {
      log.warn(
        `[${logPrefix}] timeout id=${sailResponseId} window=${completionWindow} ms=${timeoutMs}`,
      );
      return {
        ok: false,
        error: {
          type: "timeout",
          status: 504,
          message: `Request timed out after ${timeoutMs}ms (window: ${completionWindow}). Job ${sailResponseId} is still processing on Sail.`,
        },
      };
    }
    const errData = outcome.error;
    return {
      ok: false,
      error: {
        type: "upstream",
        status: 502,
        message:
          errData?.error?.message || `Sail request ${sailResponseId} failed`,
      },
    };
  }

  return { ok: true, data: outcome.result };
}

function safeParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function raceWaiterAgainstTimeout(
  reg: WaiterRegistration,
  completionWindow: Exclude<CompletionWindow, "asap">,
  sailResponseId: string,
  logPrefix: string,
): Promise<BatchResult> {
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[${logPrefix}] waiter registered id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
  );

  const resultPromise = reg.promise
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ ok: false; error: "timeout" }>(
    (resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        timeoutMs,
      );
    },
  );

  let outcome: { ok: true; result: any } | { ok: false; error: any };
  try {
    outcome = await Promise.race([resultPromise, timeoutPromise]);
  } finally {
    // Always clear the timer — without this, the resolved-first path leaves a
    // long-lived (5–60 min) timer in the event loop per successful request.
    if (timer) clearTimeout(timer);
    // Always cancel — removes only this waiter; safe no-op if it has already
    // resolved/rejected. Critical for the dedup case where multiple waiters
    // share a sailResponseId: cancelling one must not affect the others.
    reg.cancel();
  }

  log.debug(`[${logPrefix}] outcome id=${sailResponseId} ok=${outcome.ok}`);

  if (!outcome.ok) {
    if (outcome.error === "timeout") {
      log.warn(
        `[${logPrefix}] timeout id=${sailResponseId} window=${completionWindow} ms=${timeoutMs}`,
      );
      return {
        ok: false,
        error: {
          type: "timeout",
          status: 504,
          message: `Request timed out after ${timeoutMs}ms (window: ${completionWindow}). Job ${sailResponseId} is still processing on Sail.`,
        },
      };
    }
    // Sail returned a failed/cancelled status
    const errData = outcome.error;
    return {
      ok: false,
      error: {
        type: "upstream",
        status: 502,
        message:
          errData?.error?.message || `Sail request ${sailResponseId} failed`,
      },
    };
  }

  return { ok: true, data: outcome.result };
}

// ── Error formatting helpers ────────────────────────────────────────────
// Each API surface formats errors differently. These helpers reduce duplication.

/**
 * Format a BatchError as an OpenAI-style error response (chat-completions, responses).
 */
export function formatOpenAIError(error: BatchError): Response {
  if (error.type === "timeout") {
    return openAIError(error.status, error.message, "timeout_error");
  }
  if (error.type === "sail_api" && error.sailBody) {
    return mapSailError(error.status, error.sailBody);
  }
  return openAIError(error.status, error.message, "upstream_error");
}

/**
 * Format a BatchError as an Anthropic-style error response (messages).
 */
export function formatAnthropicError(error: BatchError): Response {
  if (error.type === "timeout") {
    return Response.json(
      {
        type: "error",
        error: { type: "timeout_error", message: error.message },
      },
      { status: 504 },
    );
  }
  // Sail API or upstream error
  return Response.json(
    {
      type: "error",
      error: {
        type: "api_error",
        message: error.message,
      },
    },
    { status: error.status },
  );
}
