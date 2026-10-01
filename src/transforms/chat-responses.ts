/**
 * Chat Completions ⇄ Responses API translation for the flex window.
 *
 * Sail serves `flex` only as a background Responses request (or Batch work);
 * Chat Completions on flex is rejected with a 400. To keep chat clients (pi,
 * the finance app) working on flex, the proxy rewrites a chat request into a
 * `background: true` Responses request, polls it, and rewrites the finished
 * response back into a chat completion. Restored from the pre-2f95450
 * batching transforms, with reasoning, tool_choice, and incomplete/failed
 * handling added.
 */
import { toUnixSeconds, unixNow } from "../../shared/time.ts";

/** Build the Sail Responses body for a chat-completions request. */
export function chatToResponsesBody(body: any, window: string): any {
  const out: any = {
    model: body.model,
    input: messagesToResponsesInput(body.messages ?? []),
    background: true,
    store: true,
    metadata: { ...body.metadata, completion_window: window },
  };

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) out.max_output_tokens = maxTokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.user != null) out.user = body.user;
  if (body.prompt_cache_key != null)
    out.prompt_cache_key = body.prompt_cache_key;

  if (body.response_format) {
    const fmt = responseFormatToTextFormat(body.response_format);
    if (fmt) out.text = { format: fmt };
  }
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort };
  if (Array.isArray(body.tools)) out.tools = body.tools.map(toResponsesTool);
  if (body.tool_choice != null)
    out.tool_choice = toResponsesToolChoice(body.tool_choice);

  return out;
}

/**
 * Sail's Responses API takes structured-output config as
 * `text.format = { type, name, strict, schema, description? }`; chat's
 * `response_format` wraps the schema under `json_schema`. Sail no longer
 * accepts `json_object`, so it becomes an open-ended json_schema.
 */
export function responseFormatToTextFormat(fmt: any): any | null {
  if (fmt?.type === "json_schema") {
    const js = fmt.json_schema ?? {};
    const out: any = {
      type: "json_schema",
      name: js.name ?? "response",
      strict: js.strict ?? false,
      schema: js.schema ?? { type: "object", additionalProperties: true },
    };
    if (js.description !== undefined) out.description = js.description;
    return out;
  }
  if (fmt?.type === "json_object") {
    return {
      type: "json_schema",
      name: "response",
      strict: false,
      schema: { type: "object", additionalProperties: true },
    };
  }
  return null;
}

// Chat wraps function fields under `function`; Responses flattens them.
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

function toResponsesToolChoice(choice: any): any {
  if (choice?.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return choice;
}

/**
 * Translate chat `messages` into Responses `input` items:
 *   - assistant.tool_calls[] → one `function_call` item per call
 *   - role "tool"            → `function_call_output`
 *   - image parts            → `input_image`
 * Other messages keep the chat-style `{role, content}` shape, which Sail
 * accepts. Chat-only fields (`reasoning_content`, `name`, …) are dropped.
 */
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
      if (hasContent(msg.content)) {
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

    if (msg?.role === "assistant" && !hasContent(msg.content)) continue;

    let content = msg?.content;
    if (Array.isArray(content) && content.some(isImagePart)) {
      content = content.map(toInputPart);
    }
    items.push({ role: msg?.role, content: content ?? "" });
  }
  return items;
}

function hasContent(content: any): boolean {
  return (
    (typeof content === "string" && content.length > 0) ||
    (Array.isArray(content) && content.length > 0)
  );
}

function isImagePart(part: any): boolean {
  return (
    part?.type === "image_url" ||
    part?.type === "image" ||
    part?.type === "input_image"
  );
}

function toInputPart(part: any): any {
  if (part?.type === "text" && part.text !== undefined) {
    return { type: "input_text", text: part.text };
  }
  if (part?.type === "image_url" && part.image_url) {
    const url =
      typeof part.image_url === "string" ? part.image_url : part.image_url.url;
    const out: any = { type: "input_image", image_url: url };
    if (part.image_url.detail) out.detail = part.image_url.detail;
    return out;
  }
  if (part?.type === "image" && part.source?.type === "base64") {
    return {
      type: "input_image",
      image_url: `data:${part.source.media_type};base64,${part.source.data}`,
    };
  }
  if (part?.type === "image" && part.source?.type === "url") {
    return { type: "input_image", image_url: part.source.url };
  }
  return part;
}

// ── Response direction ────────────────────────────────────────────────────

/** Convert a terminal (completed/incomplete) Sail response to a chat completion. */
export function responsesToChatCompletion(resp: any): any {
  const output: any[] = Array.isArray(resp.output) ? resp.output : [];
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: any[] = [];

  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && part.text) text.push(part.text);
      }
    } else if (item?.type === "reasoning") {
      const parts: any[] = Array.isArray(item.content) ? item.content : [];
      const full = parts
        .filter((p) => p?.type === "reasoning_text" && p.text)
        .map((p) => p.text);
      const summary = (Array.isArray(item.summary) ? item.summary : [])
        .filter((p: any) => p?.text)
        .map((p: any) => p.text);
      reasoning.push(...(full.length > 0 ? full : summary));
    } else if (item?.type === "function_call") {
      const args = item.arguments;
      toolCalls.push({
        // call_id is the Responses correlation id; the client echoes it back
        // as tool_call_id, which must map to a call_id Sail recognises.
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments:
            typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      });
    }
  }

  const message: any = {
    role: "assistant",
    content: text.length > 0 ? text.join("") : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("\n\n");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const result: any = {
    id: resp.id,
    object: "chat.completion",
    created:
      typeof resp.created_at === "number"
        ? resp.created_at
        : resp.created_at
          ? toUnixSeconds(new Date(resp.created_at))
          : unixNow(),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason(resp, toolCalls.length > 0),
      },
    ],
  };

  if (resp.usage) {
    result.usage = {
      prompt_tokens: resp.usage.input_tokens ?? 0,
      completion_tokens: resp.usage.output_tokens ?? 0,
      total_tokens:
        resp.usage.total_tokens ??
        (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
    };
    const cached = resp.usage.input_tokens_details?.cached_tokens;
    if (cached != null) {
      result.usage.prompt_tokens_details = { cached_tokens: cached };
    }
    const reasoningTokens = resp.usage.output_tokens_details?.reasoning_tokens;
    if (reasoningTokens != null) {
      result.usage.completion_tokens_details = {
        reasoning_tokens: reasoningTokens,
      };
    }
  }

  return result;
}

function finishReason(resp: any, hasToolCalls: boolean): string {
  if (resp.status === "incomplete") {
    return resp.incomplete_details?.reason === "content_filter"
      ? "content_filter"
      : "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

/**
 * Replay a chat completion as `chat.completion.chunk` events. Sail returns
 * the whole result at once, so each part goes out as a single delta.
 */
export function completionToChunks(
  completion: any,
  includeUsage: boolean,
): any[] {
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const choice = completion.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const delta = (d: any, finish_reason: string | null = null) => ({
    ...base,
    choices: [{ index: 0, delta: d, finish_reason }],
  });

  const chunks: any[] = [delta({ role: "assistant", content: "" })];
  if (msg.reasoning_content) {
    chunks.push(delta({ reasoning_content: msg.reasoning_content }));
  }
  if (msg.content) chunks.push(delta({ content: msg.content }));
  (msg.tool_calls ?? []).forEach((tc: any, index: number) => {
    chunks.push(delta({ tool_calls: [{ index, ...tc }] }));
  });
  chunks.push(delta({}, choice.finish_reason ?? "stop"));
  if (includeUsage && completion.usage) {
    chunks.push({ ...base, choices: [], usage: completion.usage });
  }
  return chunks;
}
