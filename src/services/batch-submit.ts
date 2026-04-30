import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../logger.ts";
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

  // ── No match — submit to Sail ─────────────────────────────────────────
  log.debug(
    `[${logPrefix}] submitting to Sail keys=${Object.keys(sailBody).join(",")}`,
  );
  const { status, data } = await sail.createResponse(sailBody);
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
 */
async function waitForJob(
  sailResponseId: string,
  completionWindow: CompletionWindow,
  poller: Poller,
  logPrefix: string,
): Promise<BatchResult> {
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[${logPrefix}] waiter registered id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
  );

  const resultPromise = poller
    .registerWaiter(sailResponseId)
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  const timeoutPromise = new Promise<{ ok: false; error: "timeout" }>(
    (resolve) =>
      setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs),
  );

  const outcome = await Promise.race([resultPromise, timeoutPromise]);
  log.debug(`[${logPrefix}] outcome id=${sailResponseId} ok=${outcome.ok}`);

  if (!outcome.ok) {
    poller.unregisterWaiter(sailResponseId);
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
