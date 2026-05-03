/**
 * Verifies that `waitForJob` clears its window-timeout timer when the
 * waiter resolves first. Without this, every successful batched request
 * leaves a 5–60 minute pending timer in the event loop — a slow leak.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import { config } from "../config.ts";
import { Poller } from "./poller.ts";
import { waitForJob } from "./batch-submit.ts";

let saved: number;

beforeAll(() => {
  saved = config.windowTimeouts.flex;
  // Recognizable, large value so we can find the right setTimeout call and
  // so the timeout won't fire during the test.
  config.windowTimeouts.flex = 999_999;
});

afterAll(() => {
  config.windowTimeouts.flex = saved;
});

describe("waitForJob timer cleanup", () => {
  test("clears the window-timeout timer when the waiter resolves first", async () => {
    const poller = new Poller({} as any);

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    const sailResponseId = "stub-id-1";
    const waitPromise = waitForJob(sailResponseId, "flex", poller, "wait-test");

    // Yield so waitForJob registers the waiter and schedules its setTimeout.
    await Promise.resolve();
    await Promise.resolve();

    // Find the setTimeout placed by waitForJob — the one with our recognizable
    // 999_999ms window. Capture its returned timer handle.
    const idx = setTimeoutSpy.mock.calls.findIndex(
      (args) => args[1] === 999_999,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const windowTimerHandle = setTimeoutSpy.mock.results[idx]?.value;
    expect(windowTimerHandle).toBeDefined();

    // Resolve the waiter — this is what the poller does when it sees the job
    // complete.
    const waiters = (poller as unknown as { waiters: Map<string, any> })
      .waiters;
    const waiter = waiters.get(sailResponseId);
    expect(waiter).toBeDefined();
    waiter.resolve({ id: sailResponseId, status: "completed" });

    const result = await waitPromise;
    expect(result.ok).toBe(true);

    // The window timer should have been cleared in waitForJob's finally.
    const cleared = clearTimeoutSpy.mock.calls.some(
      (args) => args[0] === windowTimerHandle,
    );
    expect(cleared).toBe(true);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  }, 5000);
});
