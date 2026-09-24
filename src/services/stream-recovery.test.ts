import { describe, test, expect, beforeAll, afterEach } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const { parseSseEvents, completionToChunks, recoverChatStream } =
  await import("./stream-recovery.ts");
const { config } = await import("../config.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ID = "resp_01a0d086-450f-7e1f-b534-a4dc9fb03c94";
const SUPERSEDED = {
  error: {
    message:
      "the streaming attempt was superseded; fetch the completed response by id",
    type: "server_error",
  },
};

function chunk(delta: any, finish_reason: any = null) {
  return {
    id: ID,
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

const ev = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const COMPLETED = {
  id: ID,
  object: "chat.completion",
  status: "completed",
  created: 1,
  model: "m",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "I'll check.",
        reasoning_content: "Use the tool.",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

/** Upstream body emitting each string as its own network chunk. */
function upstreamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

/** Mock the retrieve endpoint with a queue of responses; records URLs. */
function mockRetrieve(responses: (() => Response)[]) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra poll");
    return next();
  }) as unknown as typeof fetch;
  return urls;
}

function dataPayloads(text: string): any[] {
  return parseSseEvents(text)
    .events.filter((e) => e.data !== undefined)
    .map((e) => (e.data === "[DONE]" ? "[DONE]" : JSON.parse(e.data!)));
}

const opts = { includeUsage: true, logPrefix: "test", pollDelaysMs: [1] };

describe("parseSseEvents", () => {
  test("splits complete events and keeps the partial remainder", () => {
    const { events, rest } = parseSseEvents(
      'event: x\ndata: {"a":1}\n\n: keepalive\n\ndata: [DO',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      raw: 'event: x\ndata: {"a":1}\n\n',
      event: "x",
      data: '{"a":1}',
    });
    expect(events[1]!.data).toBeUndefined();
    expect(rest).toBe("data: [DO");
  });
});

describe("completionToChunks", () => {
  test("rebuilds reasoning, content, tool calls, finish and usage", () => {
    const chunks = completionToChunks(COMPLETED, true);
    const deltas = chunks.map((c) => c.choices[0]?.delta);
    expect(deltas[0]).toEqual({ role: "assistant", content: "" });
    expect(deltas[1]).toEqual({ reasoning_content: "Use the tool." });
    expect(deltas[2]).toEqual({ content: "I'll check." });
    expect(deltas[3].tool_calls[0]).toEqual({
      index: 0,
      ...COMPLETED.choices[0]!.message.tool_calls[0],
    });
    expect(chunks[4]!.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[5]).toMatchObject({ choices: [], usage: COMPLETED.usage });
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(
      true,
    );
  });

  test("omits the usage chunk unless requested", () => {
    const chunks = completionToChunks(COMPLETED, false);
    expect(chunks.some((c) => c.usage)).toBe(false);
  });
});

describe("recoverChatStream", () => {
  test("passes a normal stream through byte-identical, even when split mid-event", async () => {
    const sse =
      ev(chunk({ role: "assistant", content: "" })) +
      ": heartbeat\n\n" +
      ev(chunk({ content: "héllo" })) +
      "data: [DONE]\n\n";
    const parts = [sse.slice(0, 7), sse.slice(7, 90), sse.slice(90)];
    const out = recoverChatStream(upstreamOf(parts), opts);
    expect(await new Response(out).text()).toBe(sse);
  });

  test("recovers by id when superseded before any content", async () => {
    const urls = mockRetrieve([
      () => Response.json({ ...COMPLETED, status: "in_progress", choices: [] }),
      () => Response.json({}, { status: 503 }),
      () => Response.json(COMPLETED),
    ]);
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(SUPERSEDED),
      "data: [DONE]\n\n",
    ]);
    const text = await new Response(recoverChatStream(upstream, opts)).text();

    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(`${config.sail.baseUrl}/chat/completions/${ID}`);
    expect(text).not.toContain("superseded");
    const payloads = dataPayloads(text);
    expect(payloads.at(-1)).toBe("[DONE]");
    expect(payloads.filter((p) => p === "[DONE]")).toHaveLength(1);
    const content = payloads
      .map((p) => p.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("I'll check.");
    const toolCall = payloads.find((p) => p.choices?.[0]?.delta?.tool_calls);
    expect(toolCall.choices[0].delta.tool_calls[0].function.name).toBe(
      "get_weather",
    );
  });

  test("after partial answer text, reports Sail's final status instead of recovering", async () => {
    const urls = mockRetrieve([
      () =>
        Response.json({
          id: ID,
          status: "failed",
          error: { message: "chat completion failed" },
        }),
    ]);
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(chunk({ content: "Hel" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(recoverChatStream(upstream, opts)).text();

    expect(urls).toHaveLength(1);
    const payloads = dataPayloads(text);
    const err = payloads.find((p) => p.error);
    expect(err.error.type).toBe("server_error");
    expect(err.error.message).toContain("partial output was already streamed");
    expect(err.error.message).toContain(
      `response ${ID} status=failed (chat completion failed)`,
    );
    expect(payloads.at(-1)).toBe("[DONE]");
  });

  test("recovers after reasoning-only output, without replaying reasoning", async () => {
    mockRetrieve([() => Response.json(COMPLETED)]);
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(chunk({ reasoning_content: "Thinking" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(recoverChatStream(upstream, opts)).text();

    expect(text).not.toContain("superseded");
    const payloads = dataPayloads(text);
    const reasoning = payloads
      .map((p) => p.choices?.[0]?.delta?.reasoning_content ?? "")
      .join("");
    expect(reasoning).toBe("Thinking");
    const content = payloads
      .map((p) => p.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("I'll check.");
  });

  test("rewrites the error when the response failed and no retry is available", async () => {
    mockRetrieve([
      () =>
        Response.json({
          id: ID,
          status: "failed",
          error: { message: "model crashed" },
        }),
    ]);
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(recoverChatStream(upstream, opts)).text();
    const err = dataPayloads(text).find((p) => p.error);
    expect(err.error.message).toContain(
      `response ${ID} status=failed (model crashed)`,
    );
  });

  test("retries once when the response failed, relaying the fresh stream", async () => {
    mockRetrieve([() => Response.json({ id: ID, status: "failed" })]);
    let retries = 0;
    const retrySse =
      ev({ ...chunk({ role: "assistant", content: "" }), id: "resp_retry" }) +
      ev({ ...chunk({ content: "Hi again" }), id: "resp_retry" }) +
      "data: [DONE]\n\n";
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(chunk({ reasoning_content: "hmm" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(
      recoverChatStream(upstream, {
        ...opts,
        retry: async () => {
          retries++;
          return new Response(retrySse, {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      }),
    ).text();

    expect(retries).toBe(1);
    expect(text).not.toContain("superseded");
    expect(text.endsWith(retrySse)).toBe(true);
  });

  test("retries at most once, even if the retry is superseded and fails too", async () => {
    mockRetrieve([
      () => Response.json({ id: ID, status: "failed" }),
      () => Response.json({ id: ID, status: "failed" }),
    ]);
    let retries = 0;
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(
      recoverChatStream(upstream, {
        ...opts,
        retry: async () => {
          retries++;
          return new Response(
            ev(chunk({ role: "assistant", content: "" })) + ev(SUPERSEDED),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      }),
    ).text();

    expect(retries).toBe(1);
    const errors = dataPayloads(text).filter((p) => p.error);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("status=failed");
  });

  test("reports a non-streaming retry response as a failure", async () => {
    mockRetrieve([() => Response.json({ id: ID, status: "failed" })]);
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(
      recoverChatStream(upstream, {
        ...opts,
        retry: async () =>
          Response.json({ error: { message: "overloaded" } }, { status: 503 }),
      }),
    ).text();
    const err = dataPayloads(text).find((p) => p.error);
    expect(err.error.message).toContain("retry returned HTTP 503");
  });

  test("stops polling when the client disconnects", async () => {
    let polls = 0;
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      if (++polls === 2) ac.abort();
      return Response.json({ id: ID, status: "in_progress", choices: [] });
    }) as unknown as typeof fetch;
    const upstream = upstreamOf([
      ev(chunk({ role: "assistant", content: "" })),
      ev(SUPERSEDED),
    ]);
    const text = await new Response(
      recoverChatStream(upstream, { ...opts, clientSignal: ac.signal }),
    ).text();
    expect(polls).toBe(2);
    expect(text).not.toContain("[DONE]");
  });
});
