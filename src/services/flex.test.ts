import { describe, test, expect, beforeAll, afterEach } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const { chatCompletionViaFlex, responseViaFlex, synthesizeResponsesEvents } =
  await import("./flex.ts");
const { handleChatCompletions, handleResponses } =
  await import("../routes/api-forward.ts");
const { config } = await import("../config.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ID = "resp_flex_1";
const COMPLETED = {
  id: ID,
  object: "response",
  created_at: 1700000000,
  model: "m",
  status: "completed",
  output: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "banana" }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
};

/**
 * Mock Sail: POST /responses returns `submit`, each GET /responses/{id}
 * returns the next queued poll response. Records every call.
 */
function mockSail(submit: () => Response, polls: (() => Response)[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (method === "POST") return submit();
    const next = polls.shift();
    if (!next) throw new Error("unexpected extra poll");
    return next();
  }) as unknown as typeof fetch;
  return calls;
}

const queued = () =>
  Response.json({ id: ID, status: "queued", model: "m" }, { status: 202 });
const fast = { logPrefix: "test", delayMs: () => 1 };

describe("chatCompletionViaFlex (non-streaming)", () => {
  test("submits a background job, polls to completion, returns a chat completion", async () => {
    const calls = mockSail(queued, [
      () => Response.json({ id: ID, status: "in_progress" }),
      () => Response.json(COMPLETED),
    ]);
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "fruit?" }] },
      fast,
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("banana");

    expect(calls[0]!.url).toBe(`${config.sail.baseUrl}/responses`);
    expect(calls[0]!.body.background).toBe(true);
    expect(calls[0]!.body.metadata.completion_window).toBe("flex");
    expect(calls[0]!.body.input).toEqual([{ role: "user", content: "fruit?" }]);
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      `${config.sail.baseUrl}/responses/${ID}`,
      `${config.sail.baseUrl}/responses/${ID}`,
    ]);
  });

  test("passes a submit rejection through with its status", async () => {
    mockSail(() =>
      Response.json(
        { error: { message: "model does not support flex", type: "x" } },
        { status: 400 },
      ),
    );
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      fast,
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toBe("model does not support flex");
  });

  test("a failed job becomes a 502 carrying Sail's reason", async () => {
    mockSail(queued, [
      () =>
        Response.json({
          id: ID,
          status: "failed",
          error: { code: "server_error", message: "generation failed" },
        }),
    ]);
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      fast,
    );
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.message).toBe("generation failed");
  });

  test("keeps polling through a 5xx and times out with a 504", async () => {
    mockSail(queued, [
      () => Response.json({ error: { message: "busy" } }, { status: 503 }),
      () => Response.json({ id: ID, status: "in_progress" }),
      () => Response.json({ id: ID, status: "in_progress" }),
      () => Response.json({ id: ID, status: "in_progress" }),
    ]);
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { logPrefix: "test", delayMs: () => 5, timeoutMs: 12 },
    );
    expect(res.status).toBe(504);
  });

  test("a non-retryable poll status fails fast", async () => {
    mockSail(queued, [
      () => Response.json({ error: { message: "not found" } }, { status: 404 }),
    ]);
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      fast,
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.message).toContain("not found");
  });
});

describe("chatCompletionViaFlex (streaming)", () => {
  test("replays the result as chat chunks then [DONE]", async () => {
    mockSail(queued, [() => Response.json(COMPLETED)]);
    const res = await chatCompletionViaFlex(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      fast,
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"banana"');
    expect(text).toContain('"total_tokens":4');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("a failed job becomes an in-band error event", async () => {
    mockSail(queued, [
      () =>
        Response.json({
          id: ID,
          status: "failed",
          error: { message: "generation failed" },
        }),
    ]);
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      fast,
    );
    const text = await res.text();
    expect(text).toContain('"error":{"message":"generation failed"');
    expect(text).not.toContain("[DONE]");
  });

  test("a client disconnect stops polling", async () => {
    let polls = 0;
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      if (init?.method === "POST") return queued();
      polls++;
      return Response.json({ id: ID, status: "in_progress" });
    }) as unknown as typeof fetch;
    const client = new AbortController();
    const res = await chatCompletionViaFlex(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      { logPrefix: "test", delayMs: () => 5, clientSignal: client.signal },
    );
    const reader = res.body!.getReader();
    await Bun.sleep(30);
    client.abort();
    await reader.cancel();
    const seen = polls;
    await Bun.sleep(30);
    expect(seen).toBeGreaterThan(0);
    expect(polls).toBe(seen);
  });
});

describe("responseViaFlex", () => {
  test("runs a foreground request in the background and returns the result", async () => {
    const calls = mockSail(queued, [() => Response.json(COMPLETED)]);
    const res = await responseViaFlex(
      { model: "m", input: "fruit?", stream: false },
      fast,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe(ID);
    expect(calls[0]!.body).toEqual({
      model: "m",
      input: "fruit?",
      background: true,
      store: true,
      metadata: { completion_window: "flex" },
    });
  });

  test("synthesizes the Responses streaming event sequence", () => {
    const types = synthesizeResponsesEvents(COMPLETED).map(
      (e) => e.split("\n")[0],
    );
    expect(types).toEqual([
      "event: response.created",
      "event: response.output_item.added",
      "event: response.content_part.added",
      "event: response.output_text.delta",
      "event: response.output_text.done",
      "event: response.content_part.done",
      "event: response.output_item.done",
      "event: response.completed",
    ]);
  });
});

function post(path: string, body: any) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("route wiring", () => {
  test("flex chat completions go through a background Responses job", async () => {
    // A job Sail reports completed at submit needs no polling.
    const calls = mockSail(() => Response.json(COMPLETED, { status: 200 }));
    const res = await handleChatCompletions(
      post("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
      "flex",
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${config.sail.baseUrl}/responses`);
    expect(((await res.json()) as any).choices[0].message.content).toBe(
      "banana",
    );
  });

  test("balanced chat completions are still forwarded verbatim", async () => {
    const calls = mockSail(() => Response.json({ ok: true }));
    await handleChatCompletions(
      post("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
      "balanced",
    );
    expect(calls[0]!.url).toBe(`${config.sail.baseUrl}/chat/completions`);
  });

  test("a background flex Responses request passes through untouched", async () => {
    const calls = mockSail(() =>
      Response.json({ id: ID, status: "queued" }, { status: 202 }),
    );
    const res = await handleResponses(
      post("/v1/responses", { model: "m", input: "hi", background: true }),
      "flex",
    );
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
  });
});
