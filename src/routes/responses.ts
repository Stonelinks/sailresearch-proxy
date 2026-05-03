import { sail } from "../sail-client.ts";
import { log } from "../../shared/logger.ts";
import { openAIError } from "../errors.ts";
import { handlePassthroughResponses } from "../services/passthrough.ts";
import { submitAndWait, formatOpenAIError } from "../services/batch-submit.ts";
import { parseRequest } from "./parse-request.ts";
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
  const parsed = await parseRequest(req, {
    routeName: "responses",
    urlPrefix,
  });
  if ("error" in parsed) return parsed.error;
  const { body, completionWindow } = parsed.ok;

  if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
    return openAIError(
      400,
      "input is required and must be a non-empty array or string",
      "invalid_request_error",
      "input",
    );
  }

  log.debug(
    `[responses] model=${body.model} window=${completionWindow} input=${typeof body.input === "string" ? "string" : `array[${body.input.length}]`}`,
  );

  // Import db lazily to allow test mocking
  const { prisma } = await import("../db.ts");
  const dbClient = db ?? prisma;

  if (completionWindow === "asap") {
    return handlePassthroughResponses(body, completionWindow);
  }

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
