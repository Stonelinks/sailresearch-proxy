import { describe, test, expect } from "bun:test";
import { chatToResponsesAPI } from "./request.ts";

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

  test("flattens chat-completions tools to Responses API shape", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      },
    ];
    const result = chatToResponsesAPI(
      { model: "m", messages: [], tools, tool_choice: "auto" },
      "standard",
    );
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get current weather",
        parameters: { type: "object", properties: {} },
        strict: true,
      },
    ]);
    expect(result.tool_choice).toBe("auto");
  });

  test("omits optional tool fields when not provided", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "ping",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const result = chatToResponsesAPI(
      { model: "m", messages: [], tools },
      "standard",
    );
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "ping",
        parameters: { type: "object", properties: {} },
      },
    ]);
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

  test("translates assistant tool_calls into function_call input items", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          { role: "user", content: "what's the weather in SF?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"SF"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_abc", content: "sunny, 72F" },
          { role: "user", content: "thanks" },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      { role: "user", content: "what's the weather in SF?" },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"location":"SF"}',
      },
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: "sunny, 72F",
      },
      { role: "user", content: "thanks" },
    ]);
  });

  test("emits an assistant message before function_calls when content is present", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: "I'll check that.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
        ],
      },
      "standard",
    );
    expect(result.input).toEqual([
      { role: "assistant", content: "I'll check that." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
    ]);
  });

  test("stringifies non-string tool message content", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "tool",
            tool_call_id: "call_x",
            content: { result: "ok", count: 3 },
          },
        ],
      },
      "standard",
    );
    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_x",
        output: '{"result":"ok","count":3}',
      },
    ]);
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

describe("image content transforms", () => {
  test("OpenAI image_url with URL → input_image with image_url", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What's in this image?" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/cat.jpg" },
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What's in this image?" },
          {
            type: "input_image",
            image_url: "https://example.com/cat.jpg",
          },
        ],
      },
    ]);
  });

  test("OpenAI image_url with data URI → input_image with image_url (data URI)", () => {
    const dataUri = "data:image/jpeg;base64,/9j/4AAQ";
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: dataUri },
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_image", image_url: dataUri }],
      },
    ]);
  });

  test("OpenAI image_url with detail → input_image with detail", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "https://example.com/cat.jpg",
                  detail: "high",
                },
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/cat.jpg",
            detail: "high",
          },
        ],
      },
    ]);
  });

  test("Anthropic image with base64 source → input_image with data URI", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "b64data",
                },
              },
              { type: "text", text: "Describe this" },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,b64data",
          },
          { type: "input_text", text: "Describe this" },
        ],
      },
    ]);
  });

  test("Anthropic image with url source → input_image with image_url", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://example.com/cat.jpg",
                },
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/cat.jpg",
          },
        ],
      },
    ]);
  });

  test("input_image blocks pass through unchanged", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is this?" },
              {
                type: "input_image",
                image_url: "https://example.com/cat.jpg",
                detail: "auto",
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          {
            type: "input_image",
            image_url: "https://example.com/cat.jpg",
            detail: "auto",
          },
        ],
      },
    ]);
  });

  test("mixed content: text + image in same message", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe these:" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.jpg" },
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "pngdata",
                },
              },
            ],
          },
        ],
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe these:" },
          { type: "input_image", image_url: "https://example.com/a.jpg" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,pngdata",
          },
        ],
      },
    ]);
  });

  test("string content with no images passes through unchanged", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [{ role: "user", content: "Just text" }],
      },
      "standard",
    );
    expect(result.input).toEqual([{ role: "user", content: "Just text" }]);
  });

  test("array content with text-only parts passes through unchanged", () => {
    const result = chatToResponsesAPI(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      },
      "standard",
    );
    // No image parts, so the original message passes through as-is
    expect(result.input).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
  });
});
