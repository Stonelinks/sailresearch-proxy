import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";

// Set required env vars before any imports that use config
beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

// We test the handleMessages function by mocking the sail client.
const mockCreateMessage =
  mock<(body: any) => Promise<{ status: number; data: any }>>();

mock.module("../sail-client.ts", () => ({
  sail: {
    createMessage: mockCreateMessage,
  },
}));

const { handleMessages } = await import("../routes/messages.ts");

function makeMessagesRequest(body: any, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("handleMessages", () => {
  beforeEach(() => {
    mockCreateMessage.mockReset();
  });

  test("returns 400 when model is missing", async () => {
    const req = makeMessagesRequest({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("model is required");
  });

  test("returns 400 when messages is missing", async () => {
    const req = makeMessagesRequest({
      model: "test-model",
      max_tokens: 1024,
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("messages is required");
  });

  test("returns 400 when messages is empty", async () => {
    const req = makeMessagesRequest({
      model: "test-model",
      messages: [],
      max_tokens: 1024,
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(400);
  });

  test("forwards request with metadata.completion_window injected", async () => {
    mockCreateMessage.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        model: "test-model",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });

    const req = makeMessagesRequest({
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
    });
    const res = await handleMessages(req);

    expect(res.status).toBe(200);
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);

    const forwardedBody = mockCreateMessage.mock.calls[0]![0];
    expect(forwardedBody.metadata.completion_window).toBe("standard");
    expect(forwardedBody.model).toBe("test-model");
    expect(forwardedBody.messages).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  test("strips unsupported fields (system, thinking, tools, etc.)", async () => {
    mockCreateMessage.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        model: "test-model",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });

    const req = makeMessagesRequest({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      system: "You are a helper",
      thinking: { type: "enabled", budget_tokens: 1000 },
      tools: [{ name: "get_weather" }],
      tool_choice: "auto",
      stop_sequences: ["END"],
      top_k: 40,
      stream: true,
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(200);

    const forwardedBody = mockCreateMessage.mock.calls[0]![0];
    expect(forwardedBody.system).toBeUndefined();
    expect(forwardedBody.thinking).toBeUndefined();
    expect(forwardedBody.tools).toBeUndefined();
    expect(forwardedBody.tool_choice).toBeUndefined();
    expect(forwardedBody.stop_sequences).toBeUndefined();
    expect(forwardedBody.top_k).toBeUndefined();
    expect(forwardedBody.stream).toBeUndefined();
  });

  test("uses completion window from URL prefix", async () => {
    mockCreateMessage.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        model: "test-model",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });

    const req = makeMessagesRequest(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1024,
      },
      { "x-completion-window": "flex" },
    );
    const res = await handleMessages(req, "flex");
    expect(res.status).toBe(200);

    const forwardedBody = mockCreateMessage.mock.calls[0]![0];
    expect(forwardedBody.metadata.completion_window).toBe("flex");
  });

  test("returns Sail error in Anthropic-compatible format", async () => {
    mockCreateMessage.mockResolvedValueOnce({
      status: 400,
      data: {
        error: {
          type: "invalid_request_error",
          message: "model 'x' does not support image input",
        },
      },
    });

    const req = makeMessagesRequest({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("does not support image input");
  });

  test("forwards Anthropic image blocks unchanged to Sail", async () => {
    mockCreateMessage.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "A cat" }],
        model: "moonshotai/Kimi-K2.5",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 5 },
      },
    });

    const req = makeMessagesRequest({
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
    });
    const res = await handleMessages(req);
    expect(res.status).toBe(200);

    const forwardedBody = mockCreateMessage.mock.calls[0]![0];
    // Anthropic image blocks are forwarded as-is to Sail's /v1/messages
    expect(forwardedBody.messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cat.jpg" },
      },
      { type: "text", text: "What's in this image?" },
    ]);
  });
});
