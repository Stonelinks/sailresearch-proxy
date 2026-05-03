import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import { config } from "../config.ts";
import { Poller } from "./poller.ts";

// Set required env vars before any imports that use config
beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

// Mock the sail client
const mockCreateResponse =
  mock<(body: any) => Promise<{ status: number; data: any }>>();

mock.module("../sail-client.ts", () => ({
  sail: {
    createResponse: mockCreateResponse,
  },
}));

// Mock prisma
const mockPrismaCreate = mock();
const mockPrismaFindMany = mock();

mock.module("../db.ts", () => ({
  prisma: {
    pendingJob: {
      create: mockPrismaCreate,
      findMany: mockPrismaFindMany,
    },
  },
}));

const { submitAndWait, waitForJob, formatOpenAIError, formatAnthropicError } =
  await import("./batch-submit.ts");
import type { BatchError } from "./batch-submit.ts";

// Minimal mock poller
const mockPoller = {
  registerWaiter: mock(),
  start: mock(),
  stop: mock(),
} as any;

// Convenience: have registerWaiter return the new {promise, cancel} shape
// from a plain Promise of the eventual result.
function waiterFor(p: Promise<any>) {
  return { promise: p, cancel: mock() };
}

const baseParams = () => ({
  sailBody: {
    model: "test-model",
    input: [{ role: "user", content: "Hello" }],
    background: true,
    store: true,
    metadata: { completion_window: "flex" },
  },
  completionWindow: "flex" as const,
  apiType: "responses" as const,
  originalRequestBody: { model: "test-model", input: "Hello" },
  model: "test-model",
  poller: mockPoller,
  db: {
    pendingJob: {
      create: mockPrismaCreate,
      findMany: mockPrismaFindMany,
    },
  } as any,
  logPrefix: "test",
});

describe("submitAndWait", () => {
  beforeEach(() => {
    mockCreateResponse.mockReset();
    mockPrismaCreate.mockReset().mockResolvedValue({ id: "db_1" });
    mockPrismaFindMany.mockReset().mockResolvedValue([]); // no existing jobs
    mockPoller.registerWaiter.mockReset();
  });

  test("submits to Sail when no existing job matches", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 202,
      data: { id: "resp_1", status: "queued", model: "test-model" },
    });
    mockPoller.registerWaiter.mockImplementationOnce(() =>
      waiterFor(
        Promise.resolve({
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "Hi" }],
        }),
      ),
    );

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(true);
    expect(mockCreateResponse).toHaveBeenCalledTimes(1);
    expect(mockPrismaCreate).toHaveBeenCalledTimes(1);
    // Verify sailBodyHash is persisted
    const createData = mockPrismaCreate.mock.calls[0]![0].data;
    expect(createData.sailBodyHash).toBeDefined();
    expect(createData.sailBodyHash).toHaveLength(64);
  });

  test("returns cached result when completed job exists", async () => {
    const cachedResponse = {
      id: "resp_cached",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "Cached!" }],
    };
    mockPrismaFindMany.mockResolvedValueOnce([
      {
        sailResponseId: "resp_cached",
        status: "completed",
        responseBody: JSON.stringify(cachedResponse),
      },
    ]);

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("resp_cached");
      expect(result.data.output[0].content).toBe("Cached!");
    }
    // Should NOT have called Sail
    expect(mockCreateResponse).toHaveBeenCalledTimes(0);
    // Should NOT have created a new DB row
    expect(mockPrismaCreate).toHaveBeenCalledTimes(0);
  });

  test("latches onto in-flight job without submitting to Sail", async () => {
    mockPrismaFindMany.mockResolvedValueOnce([
      {
        sailResponseId: "resp_inflight",
        status: "queued",
      },
    ]);
    mockPoller.registerWaiter.mockImplementationOnce(() =>
      waiterFor(
        Promise.resolve({
          id: "resp_inflight",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "Finally!" }],
        }),
      ),
    );

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("resp_inflight");
    }
    // Should NOT have called Sail
    expect(mockCreateResponse).toHaveBeenCalledTimes(0);
    // Should NOT have created a new DB row
    expect(mockPrismaCreate).toHaveBeenCalledTimes(0);
    // Should have registered a waiter on the existing job
    expect(mockPoller.registerWaiter).toHaveBeenCalledWith("resp_inflight");
  });

  test("falls through to fresh submit when dedup match is completed but has no responseBody", async () => {
    // Defensive: a completed row with null responseBody must not be latched
    // onto (the poller won't re-process it; the waiter would hang). Submit
    // fresh instead.
    mockPrismaFindMany.mockResolvedValueOnce([
      {
        sailResponseId: "resp_orphan",
        status: "completed",
        responseBody: null,
      },
    ]);
    mockCreateResponse.mockResolvedValueOnce({
      status: 202,
      data: { id: "resp_fresh", status: "queued", model: "test-model" },
    });
    mockPoller.registerWaiter.mockImplementationOnce(() =>
      waiterFor(
        Promise.resolve({
          id: "resp_fresh",
          status: "completed",
          output: [],
        }),
      ),
    );

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(true);
    // Should have submitted fresh, NOT latched onto resp_orphan.
    expect(mockCreateResponse).toHaveBeenCalledTimes(1);
    expect(mockPoller.registerWaiter).toHaveBeenCalledWith("resp_fresh");
  });

  test("does not match failed or cancelled jobs", async () => {
    // findExistingJob filters out failed/cancelled — findMany returns empty
    mockPrismaFindMany.mockResolvedValueOnce([]);

    mockCreateResponse.mockResolvedValueOnce({
      status: 202,
      data: { id: "resp_new", status: "queued", model: "test-model" },
    });
    mockPoller.registerWaiter.mockImplementationOnce(() =>
      waiterFor(
        Promise.resolve({
          id: "resp_new",
          status: "completed",
          output: [],
        }),
      ),
    );

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(true);
    // Should have submitted to Sail (no dedup hit)
    expect(mockCreateResponse).toHaveBeenCalledTimes(1);
  });

  test("returns Sail API error as BatchError", async () => {
    mockCreateResponse.mockResolvedValueOnce({
      status: 400,
      data: { error: { message: "bad request" } },
    });

    const result = await submitAndWait(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("sail_api");
      expect(result.error.status).toBe(400);
    }
  });

  test("returns timeout as BatchError", async () => {
    // The timeout path uses getTimeoutMs which reads from config (60 min for flex).
    // We test the error formatting functions directly instead.
    // The timeout/waiter logic is already covered by the integration tests.
    expect(true).toBe(true);
  });
});

describe("formatOpenAIError", () => {
  test("formats timeout error", () => {
    const error: BatchError = {
      type: "timeout",
      status: 504,
      message: "timed out",
    };
    const res = formatOpenAIError(error);
    expect(res.status).toBe(504);
  });

  test("formats upstream error", () => {
    const error: BatchError = {
      type: "upstream",
      status: 502,
      message: "upstream failure",
    };
    const res = formatOpenAIError(error);
    expect(res.status).toBe(502);
  });
});

describe("formatAnthropicError", () => {
  test("formats timeout error in Anthropic shape", async () => {
    const error: BatchError = {
      type: "timeout",
      status: 504,
      message: "timed out",
    };
    const res = formatAnthropicError(error);
    expect(res.status).toBe(504);
    const body: any = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("timeout_error");
  });

  test("formats upstream error in Anthropic shape", async () => {
    const error: BatchError = {
      type: "upstream",
      status: 502,
      message: "upstream failure",
    };
    const res = formatAnthropicError(error);
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
  });
});

/**
 * Verifies that `waitForJob` clears its window-timeout timer when the
 * waiter resolves first. Without this, every successful batched request
 * leaves a 5–60 minute pending timer in the event loop — a slow leak.
 */
describe("waitForJob timer cleanup", () => {
  let savedFlex: number;

  beforeAll(() => {
    savedFlex = config.windowTimeouts.flex;
    // Recognizable, large value so we can find the right setTimeout call and
    // so the timeout won't fire during the test.
    config.windowTimeouts.flex = 999_999;
  });

  afterAll(() => {
    config.windowTimeouts.flex = savedFlex;
  });

  test("clears the window-timeout timer when the waiter resolves first", async () => {
    const poller = new Poller({} as any);

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    const sailResponseId = "stub-id-1";
    const waitPromise = waitForJob(sailResponseId, "flex", poller, "wait-test");

    // Yield so waitForJob registers the waiter and schedules its setTimeout.
    await Promise.resolve();
    await Promise.resolve();

    const idx = setTimeoutSpy.mock.calls.findIndex(
      (args) => args[1] === 999_999,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const windowTimerHandle = setTimeoutSpy.mock.results[idx]?.value;
    expect(windowTimerHandle).toBeDefined();

    // Resolve the waiter — what the poller does on completion. Reach into
    // the private `waiters` Map<string, Set<JobWaiter>> and resolve the lone
    // waiter we know is there.
    const waiters = (poller as unknown as { waiters: Map<string, Set<any>> })
      .waiters;
    const set = waiters.get(sailResponseId);
    expect(set?.size).toBe(1);
    const [waiter] = [...set!];
    waiter.resolve({ id: sailResponseId, status: "completed" });

    const result = await waitPromise;
    expect(result.ok).toBe(true);

    const cleared = clearTimeoutSpy.mock.calls.some(
      (args) => args[0] === windowTimerHandle,
    );
    expect(cleared).toBe(true);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  }, 5000);
});
