import { describe, test, expect } from "bun:test";
import {
  splitIntoChunks,
  formatSSE,
  streamResponse,
} from "./stream.ts";

describe("splitIntoChunks", () => {
  test("returns single chunk for short text", () => {
    expect(splitIntoChunks("hello", 20)).toEqual(["hello"]);
  });

  test("returns single chunk when text equals target size", () => {
    expect(splitIntoChunks("12345", 5)).toEqual(["12345"]);
  });

  test("splits long text", () => {
    const chunks = splitIntoChunks("hello world foo bar", 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("hello world foo bar");
  });

  test("breaks on word boundaries", () => {
    const chunks = splitIntoChunks("hello world goodbye", 12);
    // Should break at a space, not mid-word
    for (const chunk of chunks.slice(0, -1)) {
      // Non-final chunks should end with space or be at word boundary
      expect(
        chunk.endsWith(" ") ||
          !chunk.includes(" ") ||
          chunk === chunks[chunks.length - 1],
      ).toBe(true);
    }
    expect(chunks.join("")).toBe("hello world goodbye");
  });

  test("handles text with no spaces", () => {
    const chunks = splitIntoChunks("abcdefghijklmnop", 5);
    expect(chunks.join("")).toBe("abcdefghijklmnop");
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("handles empty string", () => {
    expect(splitIntoChunks("", 10)).toEqual([""]);
  });
});

describe("formatSSE", () => {
  test("formats data as SSE event", () => {
    const result = formatSSE({ hello: "world" });
    expect(result).toBe('data: {"hello":"world"}\n\n');
  });

  test("handles nested objects", () => {
    const result = formatSSE({ a: { b: 1 } });
    expect(result).toBe('data: {"a":{"b":1}}\n\n');
  });
});

describe("streamResponse", () => {
  async function collectStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<string[]> {
    const decoder = new TextDecoder();
    const events: string[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      // Split on double newline to get individual events
      const parts = text.split("\n\n").filter(Boolean);
      events.push(...parts);
    }
    return events;
  }

  function parseSSE(event: string): any {
    if (event === "data: [DONE]") return "[DONE]";
    const json = event.replace(/^data: /, "");
    return JSON.parse(json);
  }

  test("produces role chunk, content chunks, final chunk, and DONE", async () => {
    const completion = {
      id: "chatcmpl-test",
      model: "test-model",
      created: 1234567890,
      choices: [
        {
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    const events = await collectStream(streamResponse(completion));
    expect(events.length).toBeGreaterThanOrEqual(4); // role + content(s) + final + DONE

    // First event: role
    const first = parseSSE(events[0]!);
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.role).toBe("assistant");
    expect(first.choices[0].finish_reason).toBeNull();

    // Last real event before DONE: finish_reason
    const lastData = parseSSE(events[events.length - 2]!);
    expect(lastData.choices[0].finish_reason).toBe("stop");
    expect(lastData.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });

    // Final event: [DONE]
    expect(parseSSE(events[events.length - 1]!)).toBe("[DONE]");

    // Content reconstruction
    const contentParts = events
      .slice(1, -2)
      .map((e) => parseSSE(e).choices[0].delta.content);
    expect(contentParts.join("")).toBe("Hello world");
  });

  test("handles empty content", async () => {
    const completion = {
      id: "chatcmpl-empty",
      model: "m",
      created: 0,
      choices: [
        { message: { role: "assistant", content: "" }, finish_reason: "stop" },
      ],
    };

    const events = await collectStream(streamResponse(completion));
    // role + final + DONE (no content chunks)
    expect(events.length).toBe(3);
  });

  test("handles null content", async () => {
    const completion = {
      id: "chatcmpl-null",
      model: "m",
      created: 0,
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
    };

    const events = await collectStream(streamResponse(completion));
    expect(events.length).toBe(3);
  });

  test("emits delta.tool_calls chunks before the final chunk", async () => {
    const completion = {
      id: "chatcmpl-tc",
      model: "m",
      created: 0,
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"loc":"SF"}' },
              },
              {
                id: "call_def",
                type: "function",
                function: { name: "get_time", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };

    const events = await collectStream(streamResponse(completion));
    const parsed = events.slice(0, -1).map(parseSSE);

    const tcEvents = parsed.filter((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(tcEvents).toHaveLength(2);

    expect(tcEvents[0].choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: '{"loc":"SF"}' },
    });
    expect(tcEvents[1].choices[0].delta.tool_calls[0]).toEqual({
      index: 1,
      id: "call_def",
      type: "function",
      function: { name: "get_time", arguments: "{}" },
    });

    // Final non-DONE event carries finish_reason
    const finalEvent = parsed[parsed.length - 1];
    expect(finalEvent.choices[0].finish_reason).toBe("tool_calls");
  });

  test("preserves id and model across all chunks", async () => {
    const completion = {
      id: "chatcmpl-xyz",
      model: "my-model",
      created: 999,
      choices: [
        {
          message: { role: "assistant", content: "test" },
          finish_reason: "stop",
        },
      ],
    };

    const events = await collectStream(streamResponse(completion));
    for (const event of events.slice(0, -1)) {
      const parsed = parseSSE(event);
      expect(parsed.id).toBe("chatcmpl-xyz");
      expect(parsed.model).toBe("my-model");
      expect(parsed.created).toBe(999);
    }
  });
});
