import type { CompletionWindow } from "../types.ts";

export function chatToResponsesAPI(
  body: any,
  completionWindow: CompletionWindow,
): any {
  const sailBody: any = {
    model: body.model,
    input: body.messages,
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

  if (body.tools) sailBody.tools = body.tools;
  if (body.tool_choice) sailBody.tool_choice = body.tool_choice;
  if (body.user) sailBody.user = body.user;

  return sailBody;
}
