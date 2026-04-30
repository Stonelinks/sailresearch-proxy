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
const mockCreateResponse =
  mock<(body: any) => Promise<{ status: number; data: any }>>();

mock.module("../sail-client.ts", () => ({
  sail: {
    createMessage: mockCreateMessage,
    createResponse: mockCreateResponse,
  },
}));

// Mock prisma to avoid hitting real DB in unit tests
const mockPrismaCreate = mock();
mock.module("../db.ts", () => ({
  prisma: {
    pendingJob: {
      create: mockPrismaCreate,
    },
  },
}));

const { handleMessages } = await import("../routes/messages.ts");

// Minimal mock poller
const mockPoller = {
  registerWaiter: mock(),
  unregisterWaiter: mock(),
  start: mock(),
  stop: mock(),
} as any;

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
    mockCreateResponse.mockReset();
    mockPoller.registerWaiter.mockReset();
    mockPoller.unregisterWaiter.mockReset();
    mockPrismaCreate.mockReset().mockResolvedValue({ id: "db_1" });
  });

  test("returns 400 when model is missing", async () => {
    const req = makeMessagesRequest({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    });
    const res = await handleMessages(req, mockPoller);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("model is required");
  });

  test("returns 400 when messages is missing", async () => {
    const req = makeMessagesRequest({
      model: "test-model",
      max_tokens: 1024,
    });
    const res = await handleMessages(req, mockPoller);
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
    const res = await handleMessages(req, mockPoller);
    expect(res.status).toBe(400);
  });

  // ── Passthrough (asap) tests ───────────────────────────────────────────

  describe("asap (passthrough)", () => {
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

      const req = makeMessagesRequest(
        {
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
        },
        { "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller);

      expect(res.status).toBe(200);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);

      const forwardedBody = mockCreateMessage.mock.calls[0]![0];
      expect(forwardedBody.metadata.completion_window).toBe("asap");
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

      const req = makeMessagesRequest(
        {
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
        },
        { "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller);
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
        { "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller, "asap");
      expect(res.status).toBe(200);

      const forwardedBody = mockCreateMessage.mock.calls[0]![0];
      expect(forwardedBody.metadata.completion_window).toBe("asap");
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

      const req = makeMessagesRequest(
        {
          model: "x",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1024,
        },
        { "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller);
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

      const req = makeMessagesRequest(
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
        { "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller);
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

    test("accepts x-api-key header for auth (Anthropic SDK)", async () => {
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
        { "x-api-key": "some-key", "x-completion-window": "asap" },
      );
      const res = await handleMessages(req, mockPoller);
      expect(res.status).toBe(200);
    });
  });

  // ── Batching tests ─────────────────────────────────────────────────────

  describe("batched windows (priority/standard/flex)", () => {
    test("transforms to Responses API and creates pendingJob", async () => {
      mockCreateResponse.mockResolvedValueOnce({
        status: 202,
        data: {
          id: "resp_batch_123",
          status: "queued",
          model: "test-model",
        },
      });

      // Mock the poller waiter to resolve immediately with a completed response
      mockPoller.registerWaiter.mockImplementationOnce((id: string) => {
        return Promise.resolve({
          id: "resp_batch_123",
          status: "completed",
          model: "test-model",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from batch!" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      });

      const req = makeMessagesRequest(
        {
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
        },
        { "x-completion-window": "flex" },
      );
      const res = await handleMessages(req, mockPoller);

      expect(res.status).toBe(200);

      // Should have called createResponse (not createMessage) for batching
      expect(mockCreateResponse).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledTimes(0);

      // The transformed body should be in Responses API format
      const forwardedBody = mockCreateResponse.mock.calls[0]![0];
      expect(forwardedBody.model).toBe("test-model");
      expect(forwardedBody.input).toBeDefined();
      expect(forwardedBody.background).toBe(true);
      expect(forwardedBody.metadata.completion_window).toBe("flex");

      // Should have created a DB job with apiType: "messages"
      expect(mockPrismaCreate).toHaveBeenCalledTimes(1);
      expect(mockPrismaCreate.mock.calls[0]![0].data.apiType).toBe("messages");

      // Response should be in Anthropic Messages format
      const body: any = await res.json();
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.content).toEqual([
        { type: "text", text: "Hello from batch!" },
      ]);
      expect(body.stop_reason).toBe("end_turn");
    });

    test("returns Anthropic-format error on failure", async () => {
      mockCreateResponse.mockResolvedValueOnce({
        status: 202,
        data: {
          id: "resp_fail",
          status: "queued",
          model: "test-model",
        },
      });

      mockPoller.registerWaiter.mockImplementationOnce(() => {
        return Promise.reject({
          error: { message: "Job failed on Sail" },
        });
      });

      const req = makeMessagesRequest(
        {
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
        },
        { "x-completion-window": "flex" },
      );
      const res = await handleMessages(req, mockPoller);

      expect(res.status).toBe(502);
      const body: any = await res.json();
      expect(body.type).toBe("error");
      expect(body.error.message).toContain("Job failed on Sail");
    });

    test("transforms Anthropic image blocks to input_image for Responses API", async () => {
      mockCreateResponse.mockResolvedValueOnce({
        status: 202,
        data: {
          id: "resp_img",
          status: "queued",
          model: "moonshotai/Kimi-K2.5",
        },
      });

      mockPoller.registerWaiter.mockImplementationOnce(() => {
        return Promise.resolve({
          id: "resp_img",
          status: "completed",
          model: "moonshotai/Kimi-K2.5",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "A cat" }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        });
      });

      const req = makeMessagesRequest(
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
        { "x-completion-window": "flex" },
      );
      const res = await handleMessages(req, mockPoller);

      expect(res.status).toBe(200);

      const forwardedBody = mockCreateResponse.mock.calls[0]![0];
      // Images should be transformed to input_image for Responses API
      expect(forwardedBody.input[0].content).toEqual([
        { type: "input_image", image_url: "https://example.com/cat.jpg" },
        { type: "input_text", text: "What's in this image?" },
      ]);
    });

    test("strips unsupported fields before transforming", async () => {
      mockCreateResponse.mockResolvedValueOnce({
        status: 202,
        data: {
          id: "resp_strip",
          status: "queued",
          model: "test-model",
        },
      });

      mockPoller.registerWaiter.mockImplementationOnce(() => {
        return Promise.resolve({
          id: "resp_strip",
          status: "completed",
          model: "test-model",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        });
      });

      const req = makeMessagesRequest(
        {
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1024,
          system: "You are a helper",
          thinking: { type: "enabled" },
          tools: [{ name: "get_weather" }],
          stream: true,
        },
        { "x-completion-window": "flex" },
      );
      const res = await handleMessages(req, mockPoller);
      expect(res.status).toBe(200);

      const forwardedBody = mockCreateResponse.mock.calls[0]![0];
      expect(forwardedBody.system).toBeUndefined();
      expect(forwardedBody.thinking).toBeUndefined();
      expect(forwardedBody.tools).toBeUndefined();
      expect(forwardedBody.stream).toBeUndefined();
    });

    test("synchronous completion returns Anthropic format", async () => {
      mockCreateResponse.mockResolvedValueOnce({
        status: 200,
        data: {
          id: "resp_sync",
          status: "completed",
          model: "test-model",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Instant reply" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      });

      const req = makeMessagesRequest(
        {
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
        },
        { "x-completion-window": "flex" },
      );
      const res = await handleMessages(req, mockPoller);

      expect(res.status).toBe(200);

      // Should NOT have called registerWaiter (synchronous completion)
      expect(mockPoller.registerWaiter).toHaveBeenCalledTimes(0);

      const body: any = await res.json();
      expect(body.type).toBe("message");
      expect(body.content).toEqual([{ type: "text", text: "Instant reply" }]);
    });
  });
});
