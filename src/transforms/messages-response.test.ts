import { describe, test, expect } from "bun:test";
import { responsesToMessage } from "./messages-response.ts";

describe("responsesToMessage", () => {
  test("converts structured output array", () => {
    const sailResp = {
      id: "resp_123",
      status: "completed",
      model: "moonshotai/Kimi-K2.5",
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

    const result = responsesToMessage(sailResp);

    expect(result.id).toBe("resp_123");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.model).toBe("moonshotai/Kimi-K2.5");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.stop_sequence).toBeNull();
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test("concatenates multiple output_text parts", () => {
    const result = responsesToMessage({
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
    expect(result.content).toEqual([{ type: "text", text: "Part 1 Part 2" }]);
  });

  test("handles null output", () => {
    const result = responsesToMessage({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: null,
    });
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  test("handles missing output", () => {
    const result = responsesToMessage({
      id: "resp_1",
      status: "completed",
      model: "m",
    });
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  test("fallback: extracts text from items with .text property", () => {
    const result = responsesToMessage({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [{ text: "fallback text" }],
    });
    expect(result.content).toEqual([{ type: "text", text: "fallback text" }]);
  });

  test("omits usage when not present in sail response", () => {
    const result = responsesToMessage({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hi" }],
        },
      ],
    });
    expect(result.usage).toBeUndefined();
  });

  test("always sets stop_reason to end_turn", () => {
    const result = responsesToMessage({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Done" }],
        },
      ],
    });
    expect(result.stop_reason).toBe("end_turn");
  });
});
