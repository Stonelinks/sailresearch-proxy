/**
 * Regression test: confirms the poller recovers from upstream Sail requests
 * that hang indefinitely. The historical bug was an unbounded leak of the
 * concurrency-tracking counter — once `MAX_CONCURRENT_POLLS` fetches hung,
 * `tick()` early-returned forever and event throughput stopped.
 *
 * Setup: a real Bun.serve fake-Sail that hangs forever on GET /v1/responses/:id,
 * a real `Poller` instance, a stub Prisma client. Mutates `config` at runtime
 * to shrink the request timeout so the test runs in a few seconds.
 *
 * Without the fix (no AbortSignal.timeout in sail-client.ts), the first
 * MAX_CONCURRENT_POLLS fetches hang forever, jobs beyond that batch are never
 * polled, and `pollCount` stays at 0 — the assertion fails.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Poller } from "./poller.ts";
import { swapConfig } from "../test-helpers.ts";

let hangServer: ReturnType<typeof Bun.serve>;
let restoreConfig: () => void;

beforeAll(() => {
  hangServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.startsWith("/v1/responses/")) {
        return new Promise<Response>(() => {}); // hang forever
      }
      return new Response("not found", { status: 404 });
    },
  });
  restoreConfig = swapConfig({
    sail: {
      baseUrl: `http://localhost:${hangServer.port}/v1`,
      apiKey: "test",
      pollTimeoutMs: 200,
    },
    polling: { intervalMs: 50, maxConcurrent: 3 },
  });
});

afterAll(() => {
  restoreConfig();
  hangServer.stop(true);
});

describe("Poller recovery from hung Sail requests", () => {
  test("continues polling all jobs when upstream hangs", async () => {
    type Job = {
      id: string;
      sailResponseId: string;
      status: string;
      pollCount: number;
      nextPollAt: Date;
      createdAt: Date;
      completedAt: Date | null;
      completionWindow: string;
      model: string;
      apiType: string;
      errorBody: string | null;
    };

    const jobs: Job[] = [];
    const JOB_COUNT = 10;
    for (let i = 0; i < JOB_COUNT; i++) {
      jobs.push({
        id: `job-${i}`,
        sailResponseId: `sail-${i}`,
        status: "pending",
        pollCount: 0,
        nextPollAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        completedAt: null,
        completionWindow: "flex", // 60min window — won't expire during test
        model: "test-model",
        apiType: "responses",
        errorBody: null,
      });
    }

    const prisma = {
      pendingJob: {
        findMany: async ({ where, take }: any) => {
          let result = jobs.filter(
            (j) => !["completed", "failed", "cancelled"].includes(j.status),
          );
          if (where?.nextPollAt?.lte) {
            const cutoff = where.nextPollAt.lte;
            result = result.filter((j) => j.nextPollAt <= cutoff);
          }
          if (typeof take === "number") result = result.slice(0, take);
          return result;
        },
        update: async ({ where, data }: any) => {
          const job = jobs.find((j) => j.id === where.id);
          if (job) Object.assign(job, data);
          return job;
        },
        findUnique: async ({ where }: any) =>
          jobs.find((j) => j.id === where.id) ?? null,
      },
    } as any;

    const poller = new Poller(prisma);
    poller.start();

    // 4s wait: 200ms timeout × 4 batches of 3 = ~1s for first poll round on
    // all jobs, then ~2s backoff before the second round becomes eligible.
    await new Promise((r) => setTimeout(r, 4000));

    poller.stop();
    // Let any in-flight ticks settle so prisma stub mutations complete.
    await new Promise((r) => setTimeout(r, 50));

    // Primary assertion: every job was polled at least once. Without the
    // fetch-timeout fix, only the first MAX_CONCURRENT_POLLS jobs would have
    // started polls (and those would hang forever); jobs beyond that would
    // have pollCount=0 and the assertion would fail.
    const unpolled = jobs.filter((j) => j.pollCount === 0);
    expect(unpolled).toEqual([]);

    // Secondary assertion: at least one job was polled twice, proving slots
    // were not just freed but reused across cycles.
    const reused = jobs.filter((j) => j.pollCount >= 2);
    expect(reused.length).toBeGreaterThan(0);
  }, 10_000);
});
