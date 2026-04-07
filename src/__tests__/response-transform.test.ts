import { describe, test, expect } from "bun:test";
import { responsesToChatCompletion } from "../transforms/response.ts";

describe("responsesToChatCompletion", () => {
  test("converts structured output array", () => {
    const sailResp = {
      id: "resp_123",
      status: "completed",
      model: "deepseek-ai/DeepSeek-V3.2",
      created_at: "2026-01-01T00:00:00Z",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };

    const result = responsesToChatCompletion(sailResp);

    expect(result.id).toBe("resp_123");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("deepseek-ai/DeepSeek-V3.2");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].message.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].logprobs).toBeNull();
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test("converts string output", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: "Just a string",
    });
    expect(result.choices[0].message.content).toBe("Just a string");
  });

  test("handles null output", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: null,
    });
    expect(result.choices[0].message.content).toBeNull();
  });

  test("handles missing output", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
    });
    expect(result.choices[0].message.content).toBeNull();
  });

  test("concatenates multiple output_text parts", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Part 1" },
            { type: "output_text", text: " Part 2" },
          ],
        },
      ],
    });
    expect(result.choices[0].message.content).toBe("Part 1 Part 2");
  });

  test("extracts tool calls from function_call output", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "function_call",
          id: "call_abc",
          function: {
            name: "get_weather",
            arguments: '{"location":"SF"}',
          },
        },
      ],
    });

    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls[0]).toEqual({
      id: "call_abc",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"location":"SF"}',
      },
    });
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  test("handles function_call with object arguments", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "function_call",
          id: "call_1",
          function: {
            name: "search",
            arguments: { query: "test" },
          },
        },
      ],
    });

    expect(result.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"query":"test"}',
    );
  });

  test("handles multiple tool calls", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "function_call",
          id: "call_1",
          function: { name: "fn1", arguments: "{}" },
        },
        {
          type: "function_call",
          id: "call_2",
          function: { name: "fn2", arguments: "{}" },
        },
      ],
    });

    expect(result.choices[0].message.tool_calls).toHaveLength(2);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  test("sets finish_reason to length when incomplete_details present", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: "truncated",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(result.choices[0].finish_reason).toBe("length");
  });

  test("converts created_at ISO string to unix timestamp", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      created_at: "2026-06-15T12:00:00Z",
    });
    expect(result.created).toBe(
      Math.floor(new Date("2026-06-15T12:00:00Z").getTime() / 1000),
    );
  });

  test("uses current time when created_at missing", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
    });
    const after = Math.floor(Date.now() / 1000);
    expect(result.created).toBeGreaterThanOrEqual(before);
    expect(result.created).toBeLessThanOrEqual(after);
  });

  test("omits usage when not present in sail response", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
    });
    expect(result.usage).toBeUndefined();
  });

  test("does not include tool_calls key when there are none", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: "Hello",
    });
    expect(result.choices[0].message).not.toHaveProperty("tool_calls");
  });

  test("fallback: extracts text from items with .text property", () => {
    const result = responsesToChatCompletion({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [{ text: "fallback text" }],
    });
    expect(result.choices[0].message.content).toBe("fallback text");
  });
});
