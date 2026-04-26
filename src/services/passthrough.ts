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
