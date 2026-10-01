import { describe, test, expect } from "bun:test";
import {
  chatToResponsesBody,
  completionToChunks,
  messagesToResponsesInput,
  responsesToChatCompletion,
} from "./chat-responses.ts";

describe("chatToResponsesBody", () => {
  test("builds a background flex request with mapped parameters", () => {
    const out = chatToResponsesBody(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        reasoning_effort: "high",
        response_format: {
          type: "json_schema",
          json_schema: { name: "x", schema: { type: "object" }, strict: true },
        },
        metadata: { user_id: "u" },
      },
      "flex",
    );
    expect(out).toEqual({
      model: "m",
      input: [{ role: "user", content: "hi" }],
      background: true,
      store: true,
      metadata: { user_id: "u", completion_window: "flex" },
      max_output_tokens: 100,
      temperature: 0.2,
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "x",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
  });

  test("prefers max_completion_tokens over max_tokens", () => {
    const out = chatToResponsesBody(
      { model: "m", messages: [], max_tokens: 1, max_completion_tokens: 2 },
      "flex",
    );
    expect(out.max_output_tokens).toBe(2);
  });

  test("flattens function tools and a named tool_choice", () => {
    const out = chatToResponsesBody(
      {
        model: "m",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              description: "d",
              parameters: { type: "object" },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      "flex",
    );
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "f",
        description: "d",
        parameters: { type: "object" },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: "function", name: "f" });
  });

  test("passes string tool_choice through", () => {
    const out = chatToResponsesBody(
      { model: "m", messages: [], tool_choice: "auto" },
      "flex",
    );
    expect(out.tool_choice).toBe("auto");
  });
});

describe("messagesToResponsesInput", () => {
  test("rewrites a tool round trip and drops chat-only fields", () => {
    const input = messagesToResponsesInput([
      { role: "system", content: "be brief" },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "need the tool",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "assistant", content: "Sunny.", reasoning_content: "easy" },
    ]);
    expect(input).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "weather?" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
      { role: "assistant", content: "Sunny." },
    ]);
  });

  test("converts image parts and their sibling text parts", () => {
    const [msg] = messagesToResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]);
    expect(msg.content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "https://x/y.png" },
    ]);
  });
});

const RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 1700000000,
  model: "m",
  status: "completed",
  output: [
    {
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "Use the tool." }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I'll check." }],
    },
    {
      type: "function_call",
      id: "fc_internal",
      call_id: "call_0",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    },
  ],
  usage: {
    input_tokens: 5,
    output_tokens: 7,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
};

describe("responsesToChatCompletion", () => {
  test("maps text, reasoning, tool calls and usage", () => {
    const c = responsesToChatCompletion(RESPONSE);
    expect(c).toEqual({
      id: "resp_1",
      object: "chat.completion",
      created: 1700000000,
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I'll check.",
            reasoning_content: "Use the tool.",
            tool_calls: [
              {
                id: "call_0",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });

  test("falls back to the reasoning summary", () => {
    const c = responsesToChatCompletion({
      ...RESPONSE,
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "s" }] },
      ],
    });
    expect(c.choices[0].message.reasoning_content).toBe("s");
    expect(c.choices[0].message.content).toBeNull();
    expect(c.choices[0].finish_reason).toBe("stop");
  });

  test("maps incomplete responses to length / content_filter", () => {
    const base = { ...RESPONSE, output: [], status: "incomplete" };
    expect(
      responsesToChatCompletion({
        ...base,
        incomplete_details: { reason: "max_output_tokens" },
      }).choices[0].finish_reason,
    ).toBe("length");
    expect(
      responsesToChatCompletion({
        ...base,
        incomplete_details: { reason: "content_filter" },
      }).choices[0].finish_reason,
    ).toBe("content_filter");
  });
});

describe("completionToChunks", () => {
  test("replays reasoning, content, tool calls, finish and usage", () => {
    const chunks = completionToChunks(
      responsesToChatCompletion(RESPONSE),
      true,
    );
    const deltas = chunks.map((c) => c.choices[0]?.delta);
    expect(deltas[0]).toEqual({ role: "assistant", content: "" });
    expect(deltas[1]).toEqual({ reasoning_content: "Use the tool." });
    expect(deltas[2]).toEqual({ content: "I'll check." });
    expect(deltas[3].tool_calls[0]).toMatchObject({
      index: 0,
      id: "call_0",
      function: { name: "get_weather" },
    });
    expect(chunks[4].choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[5]).toMatchObject({
      choices: [],
      usage: { total_tokens: 12 },
    });
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(
      true,
    );
  });

  test("omits the usage chunk unless requested", () => {
    const chunks = completionToChunks(
      responsesToChatCompletion(RESPONSE),
      false,
    );
    expect(chunks.some((c) => c.usage)).toBe(false);
  });
});
