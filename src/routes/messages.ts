import { sail } from "../sail-client.ts";
import { log } from "../../shared/logger.ts";
import { openAIError } from "../errors.ts";
import { messagesToResponsesAPI } from "../transforms/messages-request.ts";
import { responsesToMessage } from "../transforms/messages-response.ts";
import { stripForSailMessages } from "../transforms/sail-fields.ts";
import { parseRequest } from "./parse-request.ts";
import {
  submitAndWait,
  formatAnthropicError,
} from "../services/batch-submit.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";
import type { PrismaClient } from "@prisma/client";

/**
 * Handle POST /v1/messages — Anthropic Messages API.
 *
 * For asap window: forward directly to Sail's /v1/messages (passthrough).
 * Sail natively supports this endpoint, so no format transformation needed.
 *
 * For batched windows: transform the Anthropic Messages request into Sail's
 * Responses API format, submit with background:true, create a pendingJob,
 * poll until complete, and transform the result back to Anthropic Messages
 * format. This ensures jobs appear on the dashboard and benefit from the
 * poller's timeout/expiry handling.
 */
export async function handleMessages(
  req: Request,
  poller: Poller | null = null,
  urlPrefix: CompletionWindow | null = null,
  db?: PrismaClient,
): Promise<Response> {
  const parsed = await parseRequest(req, {
    routeName: "messages",
    urlPrefix,
  });
  if ("error" in parsed) return parsed.error;
  const { body, completionWindow } = parsed.ok;

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return openAIError(
      400,
      "messages is required and must be a non-empty array",
      "invalid_request_error",
      "messages",
    );
  }

  log.debug(
    `[messages] model=${body.model} window=${completionWindow} msgs=${body.messages.length}`,
  );

  // For asap window: passthrough to Sail's native /v1/messages
  if (completionWindow === "asap") {
    return handleMessagesPassthrough(body, completionWindow);
  }

  // For batched windows: transform → Responses API → poll → transform back
  if (!poller) {
    log.error(
      "[messages] poller required for batched windows but not provided",
    );
    return openAIError(500, "Internal server error: poller not available");
  }

  // Import db lazily to allow test mocking
  const { prisma } = await import("../db.ts");
  const dbClient = db ?? prisma;

  return handleMessagesBatching(body, completionWindow, poller, dbClient);
}

/**
 * Passthrough: forward the Anthropic Messages request directly to Sail's
 * /v1/messages endpoint. Strip fields Sail doesn't support.
 */
async function handleMessagesPassthrough(
  body: any,
  completionWindow: CompletionWindow,
): Promise<Response> {
  // Build the request for Sail's /v1/messages endpoint, stripping the
  // Anthropic-only fields Sail doesn't accept (see sail-fields.ts).
  const sailBody = stripForSailMessages({
    ...body,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  });

  const { status, data } = await sail.createMessage(sailBody);
  log.debug(`[messages] sail status=${status}`);

  if (status !== 200) {
    // Return Sail's error in Anthropic-compatible format if it's already shaped
    // that way, otherwise wrap it
    if (data?.error) {
      return Response.json(data, { status });
    }
    return Response.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: data?.message || `Sail API error: ${status}`,
        },
      },
      { status: status >= 500 ? 502 : status },
    );
  }

  return Response.json(data);
}

/**
 * Batching: transform the Anthropic Messages request into Sail's Responses API
 * format, submit with dedup-aware batch-submit, then transform the result
 * back to Anthropic Messages format.
 */
async function handleMessagesBatching(
  body: any,
  completionWindow: CompletionWindow,
  poller: Poller,
  db: PrismaClient,
): Promise<Response> {
  // Strip unsupported fields before the transform sees them, otherwise the
  // resulting Responses request would carry Anthropic-only fields Sail
  // rejects.
  const cleanBody = stripForSailMessages(body);

  // Transform Anthropic Messages → Sail Responses API
  const sailBody = messagesToResponsesAPI(cleanBody, completionWindow);
  log.debug(
    `[batch-messages] transformed request keys=${Object.keys(sailBody).join(",")}`,
  );

  const result = await submitAndWait({
    sailBody,
    completionWindow,
    apiType: "messages",
    originalRequestBody: body,
    model: body.model ?? "unknown",
    poller,
    db,
    logPrefix: "batch-messages",
  });

  if (!result.ok) {
    return formatAnthropicError(result.error);
  }

  return Response.json(responsesToMessage(result.data));
}
