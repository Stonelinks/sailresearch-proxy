import { describe, test, expect, beforeAll, afterEach } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const { handleChatCompletions, handleMessages, handleResponses } =
  await import("./api-forward.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock upstream fetch, capturing the forwarded JSON body. */
function mockUpstream(status = 200, data: any = { ok: true }) {
  const captured: { url?: string; body?: any; calls: number } = { calls: 0 };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    captured.calls++;
    captured.url = String(url);
    captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
    return Response.json(data, { status });
  }) as unknown as typeof fetch;
  return captured;
}

function makeRequest(
  path: string,
  body: any,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleChatCompletions", () => {
  test("returns 400 when model is missing", async () => {
    const upstream = mockUpstream();
    const res = await handleChatCompletions(
      makeRequest("/v1/chat/completions", {
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("model is required");
    expect(upstream.calls).toBe(0);
  });

  test("forwards with the default window injected", async () => {
    const upstream = mockUpstream();
    const res = await handleChatCompletions(
      makeRequest("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(upstream.url).toContain("/chat/completions");
    expect(upstream.body.metadata.completion_window).toBe("standard");
  });

  test("URL prefix overrides body metadata window", async () => {
    const upstream = mockUpstream();
    await handleChatCompletions(
      makeRequest("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        metadata: { completion_window: "standard" },
      }),
      "flex",
    );
    expect(upstream.body.metadata.completion_window).toBe("flex");
  });

  test("x-completion-window header selects the window", async () => {
    const upstream = mockUpstream();
    await handleChatCompletions(
      makeRequest(
        "/v1/chat/completions",
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { "x-completion-window": "priority" },
      ),
    );
    expect(upstream.body.metadata.completion_window).toBe("priority");
  });

  test("client body metadata window is respected when unprefixed", async () => {
    const upstream = mockUpstream();
    await handleChatCompletions(
      makeRequest("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        metadata: { completion_window: "asap" },
      }),
    );
    expect(upstream.body.metadata.completion_window).toBe("asap");
  });
});

describe("handleMessages", () => {
  test("returns 400 when messages is missing or empty", async () => {
    const upstream = mockUpstream();
    for (const body of [
      { model: "m", max_tokens: 10 },
      { model: "m", max_tokens: 10, messages: [] },
    ]) {
      const res = await handleMessages(makeRequest("/v1/messages", body));
      expect(res.status).toBe(400);
    }
    expect(upstream.calls).toBe(0);
  });

  test("accepts x-api-key header for auth (Anthropic SDK)", async () => {
    mockUpstream();
    const res = await handleMessages(
      makeRequest(
        "/v1/messages",
        {
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        },
        { "x-api-key": "some-key" },
      ),
    );
    expect(res.status).toBe(200);
  });

  test("forwards system/tools/thinking, drops top_k", async () => {
    const upstream = mockUpstream();
    await handleMessages(
      makeRequest("/v1/messages", {
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
        system: "be terse",
        tools: [{ name: "t" }],
        top_k: 40,
      }),
    );
    expect(upstream.body.system).toBe("be terse");
    expect(upstream.body.tools).toEqual([{ name: "t" }]);
    expect(upstream.body.top_k).toBeUndefined();
  });

  test("passes Sail errors through verbatim", async () => {
    mockUpstream(400, {
      error: {
        type: "invalid_request_error",
        message: "model 'x' does not support image input",
      },
    });
    const res = await handleMessages(
      makeRequest("/v1/messages", {
        model: "x",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("does not support image input");
  });
});

describe("handleResponses", () => {
  test("returns 400 when input is missing or empty", async () => {
    const upstream = mockUpstream();
    for (const body of [{ model: "m" }, { model: "m", input: [] }]) {
      const res = await handleResponses(makeRequest("/v1/responses", body));
      expect(res.status).toBe(400);
      const parsed: any = await res.json();
      expect(parsed.error.message).toContain("input is required");
    }
    expect(upstream.calls).toBe(0);
  });

  test("forwards to /responses with the window injected", async () => {
    const upstream = mockUpstream();
    const res = await handleResponses(
      makeRequest("/v1/responses", { model: "m", input: "hi" }, {}),
      "priority",
    );
    expect(res.status).toBe(200);
    expect(upstream.url).toContain("/responses");
    expect(upstream.body.metadata.completion_window).toBe("priority");
  });
});
