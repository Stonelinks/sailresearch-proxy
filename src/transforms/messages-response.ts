import { extractTextFragments } from "./extract-text.ts";

/**
 * Transform a Sail Responses API response back into Anthropic Messages API format.
 * Used when the /v1/messages endpoint goes through the batching path
 * (Responses API with background:true) and needs to return an Anthropic-shaped
 * response to the caller.
 *
 * Sail Responses API output → Anthropic Messages:
 *   id                    → id
 *   model                 → model
 *   output[].message.content[].output_text → content[{type:"text", text}]
 *   usage.input_tokens    → usage.input_tokens
 *   usage.output_tokens   → usage.output_tokens
 *   status "completed"    → stop_reason "end_turn"
 */
export function responsesToMessage(sailResp: any): any {
  const content = extractMessageText(sailResp.output);

  const result: any = {
    id: sailResp.id,
    type: "message",
    role: "assistant",
    content,
    model: sailResp.model,
    stop_reason: "end_turn",
    stop_sequence: null,
  };

  if (sailResp.usage) {
    result.usage = {
      input_tokens: sailResp.usage.input_tokens ?? 0,
      output_tokens: sailResp.usage.output_tokens ?? 0,
    };
  }

  return result;
}

/**
 * Extract text content from a Sail Responses API output array and return
 * it in Anthropic Messages content block format. Always returns at least
 * one block — Anthropic clients expect a non-empty content array.
 */
function extractMessageText(output: any): any[] {
  const text = extractTextFragments(output).join("");
  return [{ type: "text", text }];
}
