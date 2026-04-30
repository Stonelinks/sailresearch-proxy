import { sail } from "../sail-client.ts";
import { log } from "../logger.ts";
import { mapSailError } from "../errors.ts";
import { streamResponse } from "./stream.ts";
import type { CompletionWindow } from "../types.ts";

export async function handlePassthrough(
  body: any,
  completionWindow: CompletionWindow,
  wantsStream: boolean,
): Promise<Response> {
  // Build request for Sail's chat completions endpoint
  const sailBody = {
    ...body,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  };
  delete sailBody.stream;

  // Sail API does not support store=false (responses are always stored).
  // Pi sends store=false by default — strip it to avoid a 400 error.
  delete sailBody.store;

  // Strip other OpenAI-specific fields that Sail doesn't understand
  delete sailBody.prompt_cache_key;
  delete sailBody.prompt_cache_retention;
  delete sailBody.stream_options;

  // Sail uses max_completion_tokens, remap max_tokens for compatibility
  if (sailBody.max_tokens != null && sailBody.max_completion_tokens == null) {
    sailBody.max_completion_tokens = sailBody.max_tokens;
  }
  delete sailBody.max_tokens;

  const { status, data } = await sail.chatCompletions(sailBody);
  log.debug(`[passthrough] sail status=${status}`);

  if (status !== 200) return mapSailError(status, data);

  if (wantsStream) {
    return new Response(streamResponse(data), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
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

  const { status, data } = await sail.createResponse(sailBody);
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
