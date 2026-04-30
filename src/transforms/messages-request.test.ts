import { describe, test, expect } from "bun:test";
import { messagesToResponsesAPI } from "./messages-request.ts";

describe("messagesToResponsesAPI", () => {
  test("basic message transform", () => {
    const body = {
      model: "moonshotai/Kimi-K2.5",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
    };

    const result = messagesToResponsesAPI(body, "standard");

    expect(result.model).toBe("moonshotai/Kimi-K2.5");
    expect(result.input).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.background).toBe(true);
    expect(result.store).toBe(true);
    expect(result.metadata.completion_window).toBe("standard");
  });

  test("maps max_tokens to max_output_tokens", () => {
    const result = messagesToResponsesAPI(
      { model: "m", messages: [], max_tokens: 500 },
      "standard",
    );
    expect(result.max_output_tokens).toBe(500);
  });

  test("does not set max_output_tokens when max_tokens is not provided", () => {
    const result = messagesToResponsesAPI(
      { model: "m", messages: [] },
      "standard",
    );
    expect(result.max_output_tokens).toBeUndefined();
  });

  test("passes through temperature and top_p", () => {
    const result = messagesToResponsesAPI(
      { model: "m", messages: [], temperature: 0.7, top_p: 0.9 },
      "standard",
    );
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
  });

  test("omits temperature and top_p when not set", () => {
    const result = messagesToResponsesAPI(
      { model: "m", messages: [] },
      "standard",
    );
    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();
  });

  test("maps output_config.format with json_schema to text", () => {
    const result = messagesToResponsesAPI(
      {
        model: "m",
        messages: [],
        output_config: {
          format: {
            type: "json_schema",
            json_schema: {
              name: "Test",
              schema: { type: "object", properties: { x: { type: "number" } } },
            },
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

  test("passes through user", () => {
    const result = messagesToResponsesAPI(
      { model: "m", messages: [], user: "user-123" },
      "standard",
    );
    expect(result.user).toBe("user-123");
  });

  test("merges existing metadata with completion_window", () => {
    const result = messagesToResponsesAPI(
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

  test("completion_window param overrides metadata", () => {
    const result = messagesToResponsesAPI(
      {
        model: "m",
        messages: [],
        metadata: { completion_window: "asap" },
      },
      "standard",
    );
    expect(result.metadata.completion_window).toBe("standard");
  });

  test("does not include unsupported Anthropic fields", () => {
    const result = messagesToResponsesAPI(
      {
        model: "m",
        messages: [],
        max_tokens: 1024,
        system: "You are a helper",
        thinking: { type: "enabled", budget_tokens: 1000 },
        tools: [{ name: "get_weather" }],
        tool_choice: "auto",
        stop_sequences: ["END"],
        top_k: 40,
        stream: true,
      },
      "standard",
    );
    expect(result.system).toBeUndefined();
    expect(result.thinking).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
    expect(result.stop_sequences).toBeUndefined();
    expect(result.top_k).toBeUndefined();
    expect(result.stream).toBeUndefined();
  });

  test("transforms Anthropic image blocks to input_image via messagesToResponsesInput", () => {
    const result = messagesToResponsesAPI(
      {
        model: "moonshotai/Kimi-K2.5",
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
              { type: "text", text: "What's in this image?" },
            ],
          },
        ],
        max_tokens: 1024,
      },
      "standard",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "https://example.com/cat.jpg" },
          { type: "input_text", text: "What's in this image?" },
        ],
      },
    ]);
  });

  test("transforms Anthropic base64 image to data URI input_image", () => {
    const result = messagesToResponsesAPI(
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
            ],
          },
        ],
        max_tokens: 1024,
      },
      "flex",
    );

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/jpeg;base64,b64data" },
        ],
      },
    ]);
  });
});
