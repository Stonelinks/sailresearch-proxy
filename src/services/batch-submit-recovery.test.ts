/**
 * Regression test for the submit-path hang. The historical bug:
 * `sail.createResponse` had no per-call timeout, so a hung upstream
 * accumulated handler state until Bun's outbound socket pool to Sail was
 * exhausted. New requests then hung at `[req]` before any Sail call could
 * return — restart was the only fix.
 *
 * This test stands up a fake Sail that hangs forever on POST /v1/responses,
 * shrinks `sail.pollTimeoutMs` to 200ms, fires several concurrent submits,
 * and asserts that every one of them returns a structured BatchError within
 * a few seconds — proving the timeout fires, the handler returns, and no
 * request is left dangling.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { config } from "../config.ts";
import { Poller } from "./poller.ts";
import { submitAndWait } from "./batch-submit.ts";

let hangServer: ReturnType<typeof Bun.serve>;
let saved: {
  baseUrl: string;
  apiKey: string;
  pollTimeoutMs: number;
  inferenceTimeoutMs: number;
};

beforeAll(() => {
  hangServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        return new Promise<Response>(() => {}); // hang forever
      }
      return new Response("not found", { status: 404 });
    },
  });
  saved = {
    baseUrl: config.sail.baseUrl,
    apiKey: config.sail.apiKey,
    pollTimeoutMs: config.sail.pollTimeoutMs,
    inferenceTimeoutMs: config.sail.inferenceTimeoutMs,
  };
  config.sail.baseUrl = `http://localhost:${hangServer.port}/v1`;
  config.sail.apiKey = "test";
  config.sail.pollTimeoutMs = 200;
  config.sail.inferenceTimeoutMs = 200;
});

afterAll(() => {
  config.sail.baseUrl = saved.baseUrl;
  config.sail.apiKey = saved.apiKey;
  config.sail.pollTimeoutMs = saved.pollTimeoutMs;
  config.sail.inferenceTimeoutMs = saved.inferenceTimeoutMs;
  hangServer.stop(true);
});

describe("submitAndWait recovery from hung Sail submit", () => {
  test("each submit returns a BatchError instead of hanging", async () => {
    // Stub prisma — no existing jobs, no need to persist successfully since
    // sail.createResponse will reject before we reach the persist step.
    const prisma = {
      pendingJob: {
        findMany: async () => [],
        create: async ({ data }: any) => ({ id: "x", ...data }),
        update: async ({ where, data }: any) => ({ id: where.id, ...data }),
        findUnique: async () => null,
      },
    } as any;

    const poller = new Poller(prisma);

    // Fire several concurrent submits — without per-call timeout, all of
    // these would hang and saturate the outbound socket pool.
    const submits = Array.from({ length: 5 }, (_, i) =>
      submitAndWait({
        sailBody: { model: "test-model", input: `req-${i}` },
        completionWindow: "flex",
        apiType: "responses",
        originalRequestBody: { model: "test-model", input: `req-${i}` },
        model: "test-model",
        poller,
        db: prisma,
        logPrefix: "test",
      }),
    );

    const start = Date.now();
    // Race against a 3s wall clock — if any submit hangs, this fails.
    const results = await Promise.race([
      Promise.all(submits),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("submit hung past 3s")), 3000),
      ),
    ]);
    const elapsed = Date.now() - start;

    // Every submit must have returned a structured error (not hung).
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // A 200ms timeout on a 5s test budget — the error should be the
        // upstream/sail_api kind from the AbortError, not a window timeout.
        expect(r.error.type).not.toBe("timeout");
      }
    }
    // Soft sanity check: total time should be bounded by ~timeout + slack,
    // not approaching the 3s budget.
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);
});
