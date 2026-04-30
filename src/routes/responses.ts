import { sail } from "../sail-client.ts";
import { log } from "../logger.ts";
import { openAIError } from "../errors.ts";
import { handlePassthroughResponses } from "../services/passthrough.ts";
import { resolveCompletionWindow } from "../completion-window.ts";
import { config } from "../config.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";
import type { PrismaClient } from "@prisma/client";

/**
 * Handle POST /v1/responses — Sail Responses API (primary/stable).
 *
 * For asap window: forward directly to Sail's /v1/responses (passthrough).
 * For batched windows: submit with background:true, create pendingJob,
 * poll until complete, return the Responses API result as-is.
 */
export async function handleResponses(
  req: Request,
  poller: Poller,
  urlPrefix: CompletionWindow | null = null,
  db?: PrismaClient,
): Promise<Response> {
  // Auth check — accept both Authorization: Bearer and x-api-key (Anthropic SDK)
  if (config.proxyApiKey) {
    const auth = req.headers.get("authorization");
    const xApiKey = req.headers.get("x-api-key");
    const token = auth?.replace(/^Bearer\s+/i, "") ?? xApiKey;
    if (token !== config.proxyApiKey) {
      log.warn("[auth] rejected request: invalid api key");
      return openAIError(401, "Invalid API key", "authentication_error");
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    log.debug("[responses] invalid JSON body");
    return openAIError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!body.model) {
    return openAIError(
      400,
      "model is required",
      "invalid_request_error",
      "model",
    );
  }

  if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
    return openAIError(
      400,
      "input is required and must be a non-empty array or string",
      "invalid_request_error",
      "input",
    );
  }

  // Determine completion window
  const headerWindow = req.headers.get("x-completion-window");
  const { window: completionWindow } = resolveCompletionWindow(
    urlPrefix,
    headerWindow,
    body.metadata,
    config.defaults.completionWindow,
  );
  log.debug(
    `[responses] model=${body.model} window=${completionWindow} input=${typeof body.input === "string" ? "string" : `array[${body.input.length}]`}`,
  );

  // Import db lazily to allow test mocking
  const { prisma } = await import("../db.ts");
  const dbClient = db ?? prisma;

  if (completionWindow === "asap") {
    log.debug("[responses] dispatching to passthrough");
    return handlePassthroughResponses(body, completionWindow);
  }

  log.debug("[responses] dispatching to batching");
  return handleBatchingResponses(body, completionWindow, poller, dbClient);
}

/**
 * Submit a Responses API request through the batching path.
 * Unlike chat-completions and messages, the Responses API body is already
 * in the right format — we just need to set background:true, persist the
 * job, poll, and return the result as-is.
 */
async function handleBatchingResponses(
  body: any,
  completionWindow: CompletionWindow,
  poller: Poller,
  db: PrismaClient,
): Promise<Response> {
  // Build the Sail request body
  const sailBody: any = {
    ...body,
    background: true,
    store: true,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  };
  // Strip fields that don't belong in the Responses API request
  delete sailBody.stream;

  const { status, data } = await sail.createResponse(sailBody);
  log.debug(
    `[batch-responses] sail submit status=${status} id=${data?.id} sailStatus=${data?.status}`,
  );

  if (status !== 200 && status !== 202) {
    return mapResponsesError(status, data);
  }

  // If Sail returned a completed response synchronously
  if (data.status === "completed") {
    log.info(
      `[batch-responses] sail returned completed synchronously id=${data.id}`,
    );
    return Response.json(data);
  }

  const sailResponseId = data.id;

  // Persist to DB
  log.debug(
    `[batch-responses] persisting job id=${sailResponseId} model=${body.model} window=${completionWindow}`,
  );
  await db.pendingJob.create({
    data: {
      sailResponseId,
      status: data.status ?? "pending",
      requestBody: JSON.stringify(body),
      model: body.model ?? config.defaults.model,
      completionWindow,
      apiType: "responses",
    },
  });

  // Register in-memory waiter and await result with window-specific timeout
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[batch-responses] waiter registered id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
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
  log.debug(`[batch-responses] outcome id=${sailResponseId} ok=${outcome.ok}`);

  if (!outcome.ok) {
    poller.unregisterWaiter(sailResponseId);
    if (outcome.error === "timeout") {
      log.warn(
        `[batch-responses] timeout id=${sailResponseId} window=${completionWindow} ms=${timeoutMs}`,
      );
      return openAIError(
        504,
        `Request timed out after ${timeoutMs}ms (window: ${completionWindow}). Job ${sailResponseId} is still processing on Sail.`,
        "timeout_error",
      );
    }
    const errData = outcome.error;
    return openAIError(
      502,
      errData?.error?.message || `Sail request ${sailResponseId} failed`,
      "upstream_error",
    );
  }

  // Return the Responses API result as-is (no format transformation needed)
  return Response.json(outcome.result);
}

function getTimeoutMs(window: CompletionWindow): number {
  if (window === "asap") return 0;
  return config.windowTimeouts[window];
}

function mapResponsesError(sailStatus: number, sailBody: any): Response {
  if (sailBody?.error?.message) {
    const status = sailStatus >= 500 ? 502 : sailStatus;
    return Response.json(sailBody, { status });
  }
  return openAIError(
    sailStatus >= 500 ? 502 : sailStatus,
    sailBody?.message || `Sail API error: ${sailStatus}`,
    sailBody?.type || "upstream_error",
  );
}
