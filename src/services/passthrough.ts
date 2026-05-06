import { sail } from "../sail-client.ts";
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { SSE_HEADERS } from "../constants.ts";
import { mapSailError } from "../errors.ts";
import { streamResponse } from "./stream.ts";
import { stripForSailChatCompletions } from "../transforms/sail-fields.ts";
import type { CompletionWindow } from "../types.ts";

export async function handlePassthrough(
  body: any,
  completionWindow: CompletionWindow,
  wantsStream: boolean,
): Promise<Response> {
  // Build request for Sail's chat completions endpoint
  const sailBody: any = stripForSailChatCompletions({
    ...body,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  });

  // Sail uses max_completion_tokens; remap max_tokens before stripping it.
  if (sailBody.max_tokens != null && sailBody.max_completion_tokens == null) {
    sailBody.max_completion_tokens = sailBody.max_tokens;
  }
  delete sailBody.max_tokens;

  const { status, data } = await sail.chatCompletions(sailBody);
  log.debug(`[passthrough] sail status=${status}`);

  if (status !== 200) return mapSailError(status, data);

  if (wantsStream) {
    return new Response(streamResponse(data), {
      headers: SSE_HEADERS,
    });
  }

  return Response.json(data);
}

/**
 * Passthrough for the Responses API — forward directly to Sail's
 * /v1/responses endpoint as-is. No format transformation needed.
 */
export async function handlePassthroughResponses(
  body: any,
  completionWindow: CompletionWindow,
): Promise<Response> {
  const sailBody: any = {
    ...body,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  };
  // Strip streaming — Sail doesn't support it on Responses API
  delete sailBody.stream;

  // asap passthrough: Sail runs inference inline and returns the full result.
  const { status, data } = await sail.createResponse(sailBody, {
    timeoutMs: config.sail.inferenceTimeoutMs,
  });
  log.debug(`[passthrough-responses] sail status=${status}`);

  if (status !== 200 && status !== 202) {
    if (data?.error?.message) {
      const outStatus = status >= 500 ? 502 : status;
      return Response.json(data, { status: outStatus });
    }
    return mapSailError(status, data);
  }

  return Response.json(data);
}
