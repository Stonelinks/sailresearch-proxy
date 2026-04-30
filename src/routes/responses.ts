import { sail } from "../sail-client.ts";
import { log } from "../logger.ts";
import { openAIError } from "../errors.ts";
import { handlePassthroughResponses } from "../services/passthrough.ts";
import { resolveCompletionWindow } from "../completion-window.ts";
import { config } from "../config.ts";
import { submitAndWait, formatOpenAIError } from "../services/batch-submit.ts";
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

  const result = await submitAndWait({
    sailBody,
    completionWindow,
    apiType: "responses",
    originalRequestBody: body,
    model: body.model ?? "unknown",
    poller,
    db,
    logPrefix: "batch-responses",
  });

  if (!result.ok) {
    return formatOpenAIError(result.error);
  }

  // Return the Responses API result as-is (no format transformation needed)
  return Response.json(result.data);
}
