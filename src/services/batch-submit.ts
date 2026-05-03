import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { openAIError, mapSailError } from "../errors.ts";
import { computeSailBodyHash, findExistingJob } from "../dedup.ts";
import type { Poller } from "./poller.ts";
import type { CompletionWindow } from "../types.ts";
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
    if (existing.status === "completed" && existing.responseBody) {
      log.info(
        `[${logPrefix}] dedup hit: completed job id=${existing.sailResponseId} hash=${hash.slice(0, 12)}`,
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
        `[${logPrefix}] dedup hit: in-flight job id=${existing.sailResponseId} status=${existing.status} hash=${hash.slice(0, 12)}`,
      );
      return waitForJob(
        existing.sailResponseId,
        completionWindow,
        poller,
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
      `[${logPrefix}] sail returned completed synchronously id=${data.id}`,
    );
    return { ok: true, data };
  }

  const sailResponseId = data.id;

  // Persist to DB
  log.debug(
    `[${logPrefix}] persisting job id=${sailResponseId} model=${model} window=${completionWindow} hash=${hash.slice(0, 12)}`,
  );
  await db.pendingJob.create({
    data: {
      sailResponseId,
      status: data.status ?? "pending",
      requestBody: JSON.stringify(originalRequestBody),
      model,
      completionWindow,
      apiType,
      sailBodyHash: hash,
    },
  });

  // Wait for the job to complete
  return waitForJob(sailResponseId, completionWindow, poller, logPrefix);
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
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[${logPrefix}] waiter registered id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
  );

  const { promise, cancel } = poller.registerWaiter(sailResponseId);
  const resultPromise = promise
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
    cancel();
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
