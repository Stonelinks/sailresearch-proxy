import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  synthesizeAnthropicStreamEvents,
  streamBatchedMessages,
} from "./messages-stream.ts";
import type { BatchResult } from "./batch-submit.ts";
import { config } from "../config.ts";

function parseSSEEvents(raw: string): any[] {
  return raw
    .split("\n\n")
    .filter((s) => s.trim() && !s.startsWith(": "))
    .map((s) => {
      const json = s.replace(/^data: /, "");
      return JSON.parse(json);
    });
}

function makeSailResponse(overrides: any = {}): any {
  return {
    id: "msg_test123",
    object: "response",
    status: "completed",
    model: "test-model",
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

describe("synthesizeAnthropicStreamEvents", () => {
  test("emits correct Anthropic event sequence for a text response", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeAnthropicStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("message_start has correct structure", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeAnthropicStreamEvents(sailResp);
    const msgStart = JSON.parse(events[0]!.replace(/^data: /, ""));

    expect(msgStart.type).toBe("message_start");
    expect(msgStart.message.id).toBe("msg_test123");
    expect(msgStart.message.role).toBe("assistant");
    expect(msgStart.message.model).toBe("test-model");
    expect(msgStart.message.stop_reason).toBeNull();
    expect(msgStart.message.usage.input_tokens).toBe(10);
    expect(msgStart.message.usage.output_tokens).toBe(0);
  });

  test("content_block_delta has text_delta type", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeAnthropicStreamEvents(sailResp);
    const delta = JSON.parse(events[2]!.replace(/^data: /, ""));

    expect(delta.type).toBe("content_block_delta");
    expect(delta.index).toBe(0);
    expect(delta.delta.type).toBe("text_delta");
    expect(delta.delta.text).toBe("Hello world");
  });

  test("message_delta has end_turn stop_reason and output_tokens", () => {
    const sailResp = makeSailResponse();
    const events = synthesizeAnthropicStreamEvents(sailResp);
    const msgDelta = JSON.parse(events[4]!.replace(/^data: /, ""));

    expect(msgDelta.type).toBe("message_delta");
    expect(msgDelta.delta.stop_reason).toBe("end_turn");
    expect(msgDelta.usage.output_tokens).toBe(5);
  });

  test("handles empty text output", () => {
    const sailResp = makeSailResponse({
      output: [
        {
          type: "message",
          id: "msg_empty",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      ],
    });

    const events = synthesizeAnthropicStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    // No content_block_delta when text is empty
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("handles null output", () => {
    const sailResp = makeSailResponse({ output: null });
    const events = synthesizeAnthropicStreamEvents(sailResp);
    const parsed = events.map((e) => JSON.parse(e.replace(/^data: /, "")));

    const types = parsed.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("streamBatchedMessages", () => {
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

  test("emits heartbeats then Anthropic streaming events on success", async () => {
    let resolve!: (r: BatchResult) => void;
    const pending = new Promise<BatchResult>((r) => {
      resolve = r;
    });

    const stream = streamBatchedMessages(pending);
    const collected = collectStream(stream, 500);

    // Wait for at least one heartbeat
    await new Promise((r) => setTimeout(r, 120));

    resolve({ ok: true, data: makeSailResponse() });

    const text = await collected;
    expect(text).toContain(": heartbeat\n\n");

    const events = parseSSEEvents(text);
    const types = events.map((e) => e.type);
    expect(types).toContain("message_start");
    expect(types).toContain("message_stop");
  });

  test("emits error event on batch failure", async () => {
    const error: BatchResult = {
      ok: false,
      error: { type: "timeout", status: 504, message: "timed out" },
    };

    const stream = streamBatchedMessages(Promise.resolve(error));
    const text = await collectStream(stream, 500);
    const events = parseSSEEvents(text);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.type).toBe("api_error");
    expect(errorEvent.error.message).toBe("timed out");
  });

  test("completes immediately if result is already available", async () => {
    const result: BatchResult = { ok: true, data: makeSailResponse() };

    const stream = streamBatchedMessages(Promise.resolve(result));
    const text = await collectStream(stream, 500);

    // No heartbeats — resolved too fast
    expect(text).not.toContain(": heartbeat");

    const events = parseSSEEvents(text);
    const types = events.map((e) => e.type);
    expect(types).toContain("message_start");
    expect(types).toContain("message_stop");
  });
});
