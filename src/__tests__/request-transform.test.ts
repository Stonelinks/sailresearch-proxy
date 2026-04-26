import { describe, test, expect } from "bun:test";
import { chatToResponsesAPI } from "../transforms/request.ts";

describe("chatToResponsesAPI", () => {
  test("basic message transform", () => {
    const body = {
      model: "deepseek-ai/DeepSeek-V3.2",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = chatToResponsesAPI(body, "standard");

    expect(result.model).toBe("deepseek-ai/DeepSeek-V3.2");
    expect(result.input).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.background).toBe(true);
    expect(result.store).toBe(true);
    expect(result.metadata.completion_window).toBe("standard");
  });

  test("maps max_completion_tokens to max_output_tokens", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], max_completion_tokens: 500 },
      "standard",
    );
    expect(result.max_output_tokens).toBe(500);
  });

  test("maps max_tokens to max_output_tokens as fallback", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], max_tokens: 300 },
      "standard",
    );
    expect(result.max_output_tokens).toBe(300);
  });

  test("prefers max_completion_tokens over max_tokens", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], max_completion_tokens: 500, max_tokens: 300 },
      "standard",
    );
    expect(result.max_output_tokens).toBe(500);
  });

  test("does not set max_output_tokens when neither is provided", () => {
    const result = chatToResponsesAPI({ model: "m", messages: [] }, "standard");
    expect(result.max_output_tokens).toBeUndefined();
  });

  test("passes through temperature and top_p", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], temperature: 0.7, top_p: 0.9 },
      "standard",
    );
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
  });

  test("omits temperature and top_p when not set", () => {
    const result = chatToResponsesAPI({ model: "m", messages: [] }, "standard");
    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
  });

  test("maps json_schema response_format to text", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "Test",
            schema: { type: "object", properties: { x: { type: "number" } } },
          },
        },
      },
      "standard",
    );
    expect(result.text).toEqual({
      type: "json_schema",
      json_schema: {
        name: "Test",
        schema: { type: "object", properties: { x: { type: "number" } } },
      },
    });
  });

  test("maps json_object response_format", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], response_format: { type: "json_object" } },
      "standard",
    );
    expect(result.text).toEqual({ type: "json_schema" });
  });

  test("maps reasoning_effort", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], reasoning_effort: "high" },
      "standard",
    );
    expect(result.reasoning).toEqual({ effort: "high" });
  });

  test("passes through tools and tool_choice", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const result = chatToResponsesAPI(
      { model: "m", messages: [], tools, tool_choice: "auto" },
      "standard",
    );
    expect(result.tools).toEqual(tools);
    expect(result.tool_choice).toBe("auto");
  });

  test("passes through user", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], user: "user-123" },
      "standard",
    );
    expect(result.user).toBe("user-123");
  });

  test("merges existing metadata with completion_window", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [],
        metadata: { custom_field: "value" },
      },
      "flex",
    );
    expect(result.metadata.custom_field).toBe("value");
    expect(result.metadata.completion_window).toBe("flex");
  });

  test("priority window is passed through", () => {
    const result = chatToResponsesAPI({ model: "m", messages: [] }, "priority");
    expect(result.metadata.completion_window).toBe("priority");
  });

  test("completion_window param overrides metadata", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [],
        metadata: { completion_window: "asap" },
      },
      "standard",
    );
    expect(result.metadata.completion_window).toBe("standard");
  });

  test("does not include stream or n from original body", () => {
    const result = chatToResponsesAPI(
      { model: "m", messages: [], stream: true, n: 2 },
      "standard",
    );
    // These should not be present in the Sail Responses API request
    expect(result.stream).toBeUndefined();
    expect(result.n).toBeUndefined();
  });
});
