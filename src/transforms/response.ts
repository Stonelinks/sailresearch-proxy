export function responsesToChatCompletion(sailResp: any): any {
  const content = extractOutputText(sailResp.output);
  const toolCalls = extractToolCalls(sailResp.output);
  const finishReason = inferFinishReason(sailResp, toolCalls);

  const message: any = { role: "assistant", content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const result: any = {
    id: sailResp.id,
    object: "chat.completion",
    created: sailResp.created_at
      ? Math.floor(new Date(sailResp.created_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    model: sailResp.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };

  if (sailResp.usage) {
    result.usage = {
      prompt_tokens: sailResp.usage.input_tokens ?? 0,
      completion_tokens: sailResp.usage.output_tokens ?? 0,
      total_tokens: sailResp.usage.total_tokens ?? 0,
    };
  }

  return result;
}

function extractOutputText(output: any): string | null {
  if (output == null) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) texts.push(part.text);
        }
      }
    }
    if (texts.length > 0) return texts.join("");
    // Fallback: if no structured text found, try raw text
    for (const item of output) {
      if (item.text) return item.text;
    }
  }
  return null;
}

function extractToolCalls(output: any): any[] {
  if (!Array.isArray(output)) return [];
  const calls: any[] = [];
  let idx = 0;
  for (const item of output) {
    if (item.type === "function_call") {
      // Prefer call_id (Responses API correlation id) over id (internal msg_id)
      // so the client's tool_call_id round-trips back to a call_id Sail recognizes.
      const id = item.call_id || item.id || `call_${idx}`;
      const name = item.name ?? item.function?.name;
      const rawArgs = item.arguments ?? item.function?.arguments;
      const args =
        typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
      calls.push({
        id,
        type: "function",
        function: { name, arguments: args },
      });
      idx++;
    }
  }
  return calls;
}

function inferFinishReason(sailResp: any, toolCalls: any[]): string {
  if (toolCalls.length > 0) return "tool_calls";
  if (sailResp.status === "completed") {
    if (sailResp.incomplete_details) return "length";
    return "stop";
  }
  if (sailResp.status === "failed") return "stop";
  return "stop";
}
