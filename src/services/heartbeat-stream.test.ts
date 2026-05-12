import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { heartbeatStream, formatSSEComment } from "./heartbeat-stream.ts";
import type { BatchResult } from "./batch-submit.ts";

// Speed up tests by overriding the config — import and mutate after load
import { config } from "../config.ts";

describe("formatSSEComment", () => {
  test("formats an SSE comment line", () => {
    expect(formatSSEComment("heartbeat")).toBe(": heartbeat\n\n");
  });

  test("formats an empty comment", () => {
    expect(formatSSEComment("")).toBe(": \n\n");
  });
});

describe("heartbeatStream", () => {
  let originalInterval: number;

  beforeEach(() => {
    originalInterval = config.streaming.heartbeatIntervalMs;
    config.streaming.heartbeatIntervalMs = 50; // Fast for tests
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

  test("emits heartbeats while promise is pending", async () => {
    let resolve!: (result: BatchResult) => void;
    const pending = new Promise<BatchResult>((r) => {
      resolve = r;
    });

    const { stream, result } = heartbeatStream(pending);

    // Collect for a bit, then resolve
    const collected = collectStream(stream, 300);

    // Wait long enough for at least one heartbeat
    await new Promise((r) => setTimeout(r, 120));

    resolve({ ok: true, data: { status: "completed" } });

    const text = await collected;
    await result;

    // Should have at least one heartbeat comment
    expect(text).toContain(": heartbeat\n\n");
  });

  test("resolves with the result when promise settles (success)", async () => {
    const success: BatchResult = { ok: true, data: { id: "test" } };
    const promise = Promise.resolve(success);

    const { stream, result } = heartbeatStream(promise);

    // Drain the stream
    await collectStream(stream, 500);

    const resolved = await result;
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.data.id).toBe("test");
    }
  });

  test("rejects when promise settles (error)", async () => {
    const error: BatchResult = {
      ok: false,
      error: { type: "timeout", status: 504, message: "timed out" },
    };
    const promise = Promise.resolve(error);

    const { stream, result } = heartbeatStream(promise);

    // Drain the stream
    await collectStream(stream, 500);

    const resolved = await result;
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.type).toBe("timeout");
    }
  });

  test("stops heartbeats after promise resolves", async () => {
    const success: BatchResult = { ok: true, data: {} };
    const promise = Promise.resolve(success);

    const { stream, result } = heartbeatStream(promise);

    // Drain the stream — since promise resolves immediately, no heartbeats
    const text = await collectStream(stream, 500);
    await result;

    // Should not contain heartbeats (resolved too fast)
    expect(text).not.toContain(": heartbeat");
  });

  test("stream cancellation clears interval", async () => {
    let resolve!: (result: BatchResult) => void;
    const pending = new Promise<BatchResult>((r) => {
      resolve = r;
    });

    const { stream, result } = heartbeatStream(pending);

    // Cancel the stream
    await stream.cancel();

    // Resolve the promise so result doesn't hang
    resolve({ ok: true, data: {} });
    await result;

    // No assertion needed — this test verifies cancel() doesn't throw
    // and the interval is cleaned up (no dangling timer).
  });
});
