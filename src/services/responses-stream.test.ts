import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  synthesizeResponsesStreamEvents,
  streamBatchedResponses,
} from "./responses-stream.ts";
import { formatSSEComment } from "./heartbeat-stream.ts";
import type { BatchResult } from "./batch-submit.ts";
import { config } from "../config.ts";

function parseSSEEvents(raw: string): any[] {
  return raw
    .split("\n\n")
    .filter((s) => s.trim() && !s.startsWith(": "))
    .map((s) => {
      const json = s.replace(/^data: /, "");
      if (json === "[DONE]") return { type: "[DONE]" };
      return JSON.parse(json);
    });
}

function makeSailResponse(overrides: any = {}): any {
  return {
    id: "resp_test123",
    object: "response",
    status: "completed",
    model: "test-model",
    created_at: 1700000000,
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Hello world",
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe("synthesizeResponsesStreamEvents", () => {
  test("emits correct event sequence for a simple text response", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeResponsesStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  test("response.created has in_progress status", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeResponsesStreamEvents(sailResp);
    const created = JSON.parse(events[0]!.replace(/^data: /, ""));
    expect(created.type).toBe("response.created");
    expect(created.response.status).toBe("in_progress");
  });

  test("response.completed has the original completed status", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeResponsesStreamEvents(sailResp);
    const completed = JSON.parse(
      events[events.length - 1]!.replace(/^data: /, ""),
    );
    expect(completed.type).toBe("response.completed");
    expect(completed.response.status).toBe("completed");
  });

  test("handles multiple content parts", () => {
    const sailResp = makeSailResponse({
      output: [
        {
          type: "message",
          id: "msg_multi",
          role: "assistant",
          content: [
            { type: "output_text", text: "Part one" },
            { type: "output_text", text: "Part two" },
          ],
        },
      ],
    });

    const events = synthesizeResponsesStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const deltas = parsed.filter(
      (e) => e.type === "response.output_text.delta",
    );
    expect(deltas.length).toBe(2);
    expect(deltas[0]!.delta).toBe("Part one");
    expect(deltas[1]!.delta).toBe("Part two");
  });

  test("handles multiple output items", () => {
    const sailResp = makeSailResponse({
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "First" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      ],
    });

    const events = synthesizeResponsesStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const addedItems = parsed.filter(
      (e) => e.type === "response.output_item.added",
    );
    expect(addedItems.length).toBe(2);
    expect(addedItems[0]!.item.type).toBe("message");
    expect(addedItems[1]!.item.type).toBe("function_call");
  });

  test("handles empty output", () => {
    const sailResp = makeSailResponse({ output: [] });
    const events = synthesizeResponsesStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    expect(types).toEqual(["response.created", "response.completed"]);
  });

  test("handles null output", () => {
    const sailResp = makeSailResponse({ output: null });
    const events = synthesizeResponsesStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    expect(types).toEqual(["response.created", "response.completed"]);
  });
});

describe("streamBatchedResponses", () => {
  let originalInterval: number;

  beforeEach(() => {
    originalInterval = config.streaming.heartbeatIntervalMs;
    config.streaming.heartbeatIntervalMs = 50;
  });

  afterEach(() => {
    config.streaming.heartbeatIntervalMs = originalInterval;
  });

  async function collectStream(
    stream: ReadableStream<Uint8Array>,
    maxMs: number = 2000,
  ): Promise<string> {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = stream.getReader();
    const timeout = setTimeout(() => {
      reader.cancel();
    }, maxMs);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearTimeout(timeout);
    }
    return chunks.join("");
  }

  test("emits heartbeats then streaming events on success", async () => {
    let resolve!: (r: BatchResult) => void;
    const pending = new Promise<BatchResult>((r) => {
      resolve = r;
    });

    const stream = streamBatchedResponses(pending);

    const collected = collectStream(stream, 500);

    // Wait for at least one heartbeat
    await new Promise((r) => setTimeout(r, 120));

    resolve({ ok: true, data: makeSailResponse() });

    const text = await collected;
    const events = parseSSEEvents(text);

    // Should have heartbeat comments in the raw text
    expect(text).toContain(": heartbeat\n\n");

    // Should have response streaming events
    const types = events.map((e) => e.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
    expect(types).toContain("[DONE]");
  });

  test("emits error event on batch failure", async () => {
    const error: BatchResult = {
      ok: false,
      error: { type: "timeout", status: 504, message: "timed out" },
    };

    const stream = streamBatchedResponses(Promise.resolve(error));
    const text = await collectStream(stream, 500);
    const events = parseSSEEvents(text);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.type).toBe("timeout");
    expect(events.at(-1)?.type).toBe("[DONE]");
  });

  test("completes immediately if result is already available", async () => {
    const result: BatchResult = { ok: true, data: makeSailResponse() };

    const stream = streamBatchedResponses(Promise.resolve(result));
    const text = await collectStream(stream, 500);

    // No heartbeats — resolved too fast
    expect(text).not.toContain(": heartbeat");

    const events = parseSSEEvents(text);
    const types = events.map((e) => e.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
  });
});
