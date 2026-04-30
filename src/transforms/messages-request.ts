import type { CompletionWindow } from "../types.ts";
import { messagesToResponsesInput } from "./request.ts";

/**
 * Transform an Anthropic Messages API request body into a Sail Responses API
 * request body. Used when the /v1/messages endpoint needs to go through the
 * batching path (priority/standard/flex windows).
 *
 * Anthropic Messages fields → Sail Responses API fields:
 *   messages             → input (via messagesToResponsesInput)
 *   max_tokens           → max_output_tokens
 *   temperature          → temperature
 *   top_p                → top_p
 *   output_config.format → text
 *   metadata             → metadata (merge completion_window)
 *
 * Fields NOT mapped (Sail Messages API doesn't support them, and Responses
 * API either doesn't support them or handles them differently):
 *   system, thinking, tools, tool_choice, stop_sequences, top_k,
 *   stream, service_tier, inference_geo
 */
export function messagesToResponsesAPI(
  body: any,
  completionWindow: CompletionWindow,
): any {
  const sailBody: any = {
    model: body.model,
    input: messagesToResponsesInput(body.messages ?? []),
    background: true,
    store: true,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  };

  if (body.max_tokens != null) {
    sailBody.max_output_tokens = body.max_tokens;
  }

  if (body.temperature != null) sailBody.temperature = body.temperature;
  if (body.top_p != null) sailBody.top_p = body.top_p;

  // Map Anthropic output_config.format → Sail text
  if (body.output_config?.format) {
    const fmt = body.output_config.format;
    if (fmt.type === "json_schema") {
      sailBody.text = {
        type: "json_schema",
        json_schema: fmt.json_schema,
      };
    }
  }

  if (body.user) sailBody.user = body.user;

  return sailBody;
}
