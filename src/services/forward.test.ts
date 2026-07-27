import { describe, test, expect, beforeAll, afterEach } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const { normalizeBody, forwardToSail } = await import("./forward.ts");
const { config } = await import("../config.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock capturing the request; returns the capture object. */
function mockFetch(response: () => Response | Promise<Response>) {
  const captured: { url?: string; init?: RequestInit; body?: any } = {};
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
    return response();
  }) as unknown as typeof fetch;
  return captured;
}

describe("normalizeBody", () => {
  test("injects completion_window into metadata", () => {
    const out = normalizeBody("/chat/completions", { model: "m" }, "flex");
    expect(out.metadata).toEqual({ completion_window: "flex" });
  });

  test("merges with existing client metadata, overwriting only the window", () => {
    const out = normalizeBody(
      "/chat/completions",
      { model: "m", metadata: { user_id: "u1", completion_window: "asap" } },
      "priority",
    );
    expect(out.metadata).toEqual({
      user_id: "u1",
      completion_window: "priority",
    });
  });

  test("drops store:false but keeps store:true (chat)", () => {
    expect(
      normalizeBody("/chat/completions", { model: "m", store: false }, "asap")
        .store,
    ).toBeUndefined();
    expect(
      normalizeBody("/chat/completions", { model: "m", store: true }, "asap")
        .store,
    ).toBe(true);
  });

  test("drops only the fields Sail rejects on /messages", () => {
    const out = normalizeBody(
      "/messages",
      {
        model: "m",
        system: "be terse",
        tools: [{ name: "t" }],
        thinking: { type: "enabled" },
        stream: true,
        top_k: 40,
        stop_sequences: ["END"],
        service_tier: "auto",
        inference_geo: "us",
      },
      "asap",
    );
    // Now natively supported by Sail — must pass through
    expect(out.system).toBe("be terse");
    expect(out.tools).toEqual([{ name: "t" }]);
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.stream).toBe(true);
    // Still rejected upstream — dropped
    expect(out.top_k).toBeUndefined();
    expect(out.stop_sequences).toBeUndefined();
    expect(out.service_tier).toBeUndefined();
    expect(out.inference_geo).toBeUndefined();
  });

  test("leaves /responses bodies untouched apart from metadata", () => {
    const out = normalizeBody(
      "/responses",
      { model: "m", input: "hi", stream: true, store: false },
      "standard",
    );
    expect(out.input).toBe("hi");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.metadata.completion_window).toBe("standard");
  });

  test("does not mutate the caller's body", () => {
    const body = { model: "m", metadata: { user_id: "u1" }, top_k: 40 };
    normalizeBody("/messages", body, "flex");
    expect(body.metadata).toEqual({ user_id: "u1" });
    expect(body.top_k).toBe(40);
  });
});

describe("forwardToSail", () => {
  test("POSTs to the Sail base URL with auth and the normalized body", async () => {
    const captured = mockFetch(() => Response.json({ ok: true }));
    const res = await forwardToSail({
      path: "/chat/completions",
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      window: "priority",
      errorFormat: "openai",
      logPrefix: "test",
    });

    expect(res.status).toBe(200);
    expect(captured.url).toBe(`${config.sail.baseUrl}/chat/completions`);
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${config.sail.apiKey}`);
    expect(captured.body.metadata.completion_window).toBe("priority");
  });

  test("streams SSE bytes through unmodified", async () => {
    const sse = 'data: {"delta":"a"}\n\ndata: [DONE]\n\n';
    mockFetch(
      () =>
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const res = await forwardToSail({
      path: "/chat/completions",
      body: { model: "m", stream: true },
      window: "asap",
      errorFormat: "openai",
      logPrefix: "test",
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
  });

  test("passes upstream error status and body through verbatim", async () => {
    mockFetch(() =>
      Response.json(
        { error: { message: "completion_window not available" } },
        { status: 400 },
      ),
    );
    const res = await forwardToSail({
      path: "/chat/completions",
      body: { model: "m" },
      window: "flex",
      errorFormat: "openai",
      logPrefix: "test",
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain("completion_window");
  });

  test("strips stale content-length/encoding headers", async () => {
    mockFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "Content-Length": "9999",
          },
        }),
    );
    const res = await forwardToSail({
      path: "/responses",
      body: { model: "m", input: "hi" },
      window: "asap",
      errorFormat: "openai",
      logPrefix: "test",
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("returns OpenAI-shaped 502 when the fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("The socket connection was closed unexpectedly");
    }) as unknown as typeof fetch;
    const res = await forwardToSail({
      path: "/chat/completions",
      body: { model: "m" },
      window: "asap",
      errorFormat: "openai",
      logPrefix: "test",
    });
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("socket connection was closed");
  });

  test("returns Anthropic-shaped 502 when the fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const res = await forwardToSail({
      path: "/messages",
      body: { model: "m" },
      window: "asap",
      errorFormat: "anthropic",
      logPrefix: "test",
    });
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("Sail request failed");
  });
});
