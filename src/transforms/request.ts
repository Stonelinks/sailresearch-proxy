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
function messagesToResponsesInput(messages: any[]): any[] {
  const items: any[] = [];
  for (const msg of messages) {
    if (msg?.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string"
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
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
      }
      continue;
    }

    items.push(msg);
  }
  return items;
}
