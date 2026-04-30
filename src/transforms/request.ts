import type { CompletionWindow } from "../types.ts";

export function chatToResponsesAPI(
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

  if (body.max_completion_tokens != null) {
    sailBody.max_output_tokens = body.max_completion_tokens;
  } else if (body.max_tokens != null) {
    sailBody.max_output_tokens = body.max_tokens;
  }

  if (body.temperature != null) sailBody.temperature = body.temperature;
  if (body.top_p != null) sailBody.top_p = body.top_p;

  if (body.response_format) {
    if (body.response_format.type === "json_schema") {
      sailBody.text = {
        type: "json_schema",
        json_schema: body.response_format.json_schema,
      };
    } else if (body.response_format.type === "json_object") {
      sailBody.text = { type: "json_schema" };
    }
  }

  if (body.reasoning_effort) {
    sailBody.reasoning = { effort: body.reasoning_effort };
  }

  if (body.tools) sailBody.tools = body.tools.map(toResponsesTool);
  if (body.tool_choice) sailBody.tool_choice = body.tool_choice;
  if (body.user) sailBody.user = body.user;

  return sailBody;
}

// Chat Completions wraps function fields under `function`; the Responses API
// expects them flattened on the tool object itself.
function toResponsesTool(tool: any): any {
  if (tool?.type === "function" && tool.function) {
    const { name, description, parameters, strict } = tool.function;
    const out: any = { type: "function", name };
    if (description !== undefined) out.description = description;
    if (parameters !== undefined) out.parameters = parameters;
    if (strict !== undefined) out.strict = strict;
    return out;
  }
  return tool;
}

// Translate chat-completions `messages` into Responses API `input` items.
// Plain user/system/assistant text messages pass through (Sail accepts the
// chat-style {role, content} shape). Tool-related messages are rewritten:
//   - assistant.tool_calls[] → one {type: "function_call", call_id, name, arguments} per call
//   - role: "tool"           → {type: "function_call_output", call_id, output}
// Image content parts are transformed:
//   - OpenAI image_url     → {type: "input_image", image_url, detail?}
//   - Anthropic image      → {type: "input_image", image_url} (base64 → data URI)
//   - Sail input_image     → pass through unchanged
//   - OpenAI text          → {type: "input_text", text}
export function messagesToResponsesInput(messages: any[]): any[] {
  const items: any[] = [];
  for (const msg of messages) {
    if (msg?.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content ?? ""),
      });
      continue;
    }

    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const hasContent =
        (typeof msg.content === "string" && msg.content.length > 0) ||
        (Array.isArray(msg.content) && msg.content.length > 0);
      if (hasContent) {
        items.push({ role: "assistant", content: msg.content });
      }
      for (const call of msg.tool_calls) {
        const args = call?.function?.arguments;
        items.push({
          type: "function_call",
          call_id: call?.id,
          name: call?.function?.name,
          arguments:
            typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
      }
      continue;
    }

    // If message content is an array, check for image parts that need transforming
    if (Array.isArray(msg?.content)) {
      const transformed = transformContentParts(msg.content);
      const hasImageParts = transformed.some(
        (p: any) =>
          p.type === "input_image" ||
          p.type === "image_url" ||
          p.type === "image",
      );
      if (hasImageParts) {
        // When images are present, emit a message with content array using
        // Responses API types (input_text + input_image)
        items.push({ role: msg.role, content: transformed });
        continue;
      }
      // No images — pass through the original message as-is
    }

    items.push(msg);
  }
  return items;
}

/**
 * Transform content parts within a message's content array.
 * - OpenAI `image_url` parts → Sail `input_image` parts
 * - Anthropic `image` parts  → Sail `input_image` parts
 * - OpenAI `text` parts      → Sail `input_text` parts
 * - Sail `input_image`        → pass through
 * - Sail `input_text`         → pass through
 */
function transformContentParts(parts: any[]): any[] {
  return parts.map((part: any) => {
    // Already in Sail Responses API format
    if (part?.type === "input_image" || part?.type === "input_text") {
      return part;
    }

    // OpenAI image_url format
    if (part?.type === "image_url" && part.image_url) {
      return imageUrlToInputImage(part);
    }

    // Anthropic image format
    if (part?.type === "image" && part.source) {
      return anthropicImageToInputImage(part);
    }

    // OpenAI text format → Sail input_text
    if (part?.type === "text" && part.text !== undefined) {
      return { type: "input_text", text: part.text };
    }

    // Unknown part — pass through
    return part;
  });
}

/**
 * Convert OpenAI `image_url` content part to Sail `input_image`.
 *
 * OpenAI: { type: "image_url", image_url: { url: "...", detail?: "auto"|"low"|"high" } }
 * Sail:   { type: "input_image", image_url: "...", detail?: "auto"|"low"|"high" }
 */
function imageUrlToInputImage(part: any): any {
  const out: any = {
    type: "input_image",
    image_url: part.image_url.url,
  };
  if (part.image_url.detail) {
    out.detail = part.image_url.detail;
  }
  return out;
}

/**
 * Convert Anthropic `image` content block to Sail `input_image`.
 *
 * Anthropic URL source:
 *   { type: "image", source: { type: "url", url: "https://..." } }
 *   → { type: "input_image", image_url: "https://..." }
 *
 * Anthropic base64 source:
 *   { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } }
 *   → { type: "input_image", image_url: "data:image/jpeg;base64,..." }
 */
function anthropicImageToInputImage(part: any): any {
  const source = part.source;
  if (source?.type === "url") {
    return {
      type: "input_image",
      image_url: source.url,
    };
  }

  if (source?.type === "base64") {
    const dataUri = `data:${source.media_type};base64,${source.data}`;
    return {
      type: "input_image",
      image_url: dataUri,
    };
  }

  // Fallback: pass through as-is
  return part;
}
