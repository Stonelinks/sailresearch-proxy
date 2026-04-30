import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";

// Set required env vars before any imports that use config
beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

// We test the handleResponses function by mocking the sail client.
const mockCreateResponse =
  mock<(body: any) => Promise<{ status: number; data: any }>>();

mock.module("../sail-client.ts", () => ({
  sail: {
    createResponse: mockCreateResponse,
  },
}));

const { handleResponses } = await import("../routes/responses.ts");

function makeResponsesRequest(body: any, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Minimal mock poller
const mockPoller = {
  registerWaiter: mock(),
  unregisterWaiter: mock(),
  start: mock(),
  stop: mock(),
} as any;

describe("handleResponses", () => {
  beforeEach(() => {
    mockCreateResponse.mockReset();
  });

  test("returns 400 when model is missing", async () => {
    const req = makeResponsesRequest({
      input: "Hello",
    });
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("model is required");
  });

  test("returns 400 when input is missing", async () => {
    const req = makeResponsesRequest({
      model: "test-model",
    });
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("input is required");
  });

  test("returns 400 when input is empty array", async () => {
    const req = makeResponsesRequest({
      model: "test-model",
      input: [],
    });
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(400);
  });

  test("asap window forwards to passthrough", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "resp_123",
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello!" }],
          },
        ],
      },
    });

    const req = makeResponsesRequest(
      {
        model: "test-model",
        input: "Hello",
      },
      { "x-completion-window": "asap" },
    );
    const res = await handleResponses(req, mockPoller);

    expect(res.status).toBe(200);
    expect(mockCreateResponse).toHaveBeenCalledTimes(1);

    const forwardedBody = mockCreateResponse.mock.calls[0]![0];
    expect(forwardedBody.model).toBe("test-model");
    expect(forwardedBody.input).toBe("Hello");
    expect(forwardedBody.metadata.completion_window).toBe("asap");
  });

  test("injects completion_window into metadata", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "resp_123",
        status: "completed",
        model: "test-model",
        output: [],
      },
    });

    const req = makeResponsesRequest(
      {
        model: "test-model",
        input: "Hello",
      },
      { "x-completion-window": "asap" },
    );
    await handleResponses(req, mockPoller);

    const forwardedBody = mockCreateResponse.mock.calls[0]![0];
    expect(forwardedBody.metadata.completion_window).toBe("asap");
  });

  test("strips stream from forwarded body", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "resp_123",
        status: "completed",
        model: "test-model",
        output: [],
      },
    });

    const req = makeResponsesRequest(
      {
        model: "test-model",
        input: "Hello",
        stream: true,
      },
      { "x-completion-window": "asap" },
    );
    await handleResponses(req, mockPoller);

    const forwardedBody = mockCreateResponse.mock.calls[0]![0];
    expect(forwardedBody.stream).toBeUndefined();
  });

  test("accepts x-api-key header for auth (Anthropic SDK)", async () => {
    // This test just verifies the code path doesn't crash with x-api-key
    // Real auth testing would require setting PROXY_API_KEY env
    mockCreateResponse.mockResolvedValueOnce({
      status: 200,
      data: {
        id: "resp_123",
        status: "completed",
        model: "test-model",
        output: [],
      },
    });

    const req = makeResponsesRequest(
      { model: "test-model", input: "Hello" },
      { "x-api-key": "some-key", "x-completion-window": "asap" },
    );
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(200);
  });

  test("returns Sail error in original format", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 400,
      data: {
        error: {
          type: "invalid_request_error",
          message: "model not found",
        },
      },
    });

    const req = makeResponsesRequest(
      { model: "bad-model", input: "Hello" },
      { "x-completion-window": "asap" },
    );
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("model not found");
  });

  test("maps 5xx Sail errors to 502", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 500,
      data: {
        error: {
          type: "server_error",
          message: "Internal error",
        },
      },
    });

    const req = makeResponsesRequest(
      { model: "test-model", input: "Hello" },
      { "x-completion-window": "asap" },
    );
    const res = await handleResponses(req, mockPoller);
    expect(res.status).toBe(502);
  });
});
