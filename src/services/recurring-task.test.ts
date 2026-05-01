import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { RecurringTask } from "./recurring-task.ts";

describe("RecurringTask", () => {
  const calls: number[] = [];
  const fn = mock(async () => {
    calls.push(Date.now());
  });

  beforeEach(() => {
    fn.mockReset();
    calls.length = 0;
  });

  it("calls fn immediately when runImmediately is true", async () => {
    const task = new RecurringTask("test", fn, 60000, { runImmediately: true });
    task.start();

    // Give microtask queue a chance
    await new Promise((r) => setTimeout(r, 10));

    expect(fn).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("waits for interval before first call when runImmediately is false", async () => {
    const task = new RecurringTask("test", fn, 50);
    task.start();

    await new Promise((r) => setTimeout(r, 10));
    expect(fn).toHaveBeenCalledTimes(0);

    await new Promise((r) => setTimeout(r, 60));
    expect(fn).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("waits full interval after a slow fn completes", async () => {
    const slowFn = mock(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    const task = new RecurringTask("test", slowFn, 50, {
      runImmediately: true,
    });
    task.start();

    // After slow fn (80ms) + interval (50ms) = 130ms for second call
    await new Promise((r) => setTimeout(r, 100));
    expect(slowFn).toHaveBeenCalledTimes(1); // not yet called again

    await new Promise((r) => setTimeout(r, 60));
    expect(slowFn).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it("continues loop after fn throws", async () => {
    let callCount = 0;
    const failingFn = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
    });

    const task = new RecurringTask("test", failingFn, 30, {
      runImmediately: true,
    });
    task.start();

    await new Promise((r) => setTimeout(r, 80));
    expect(callCount).toBeGreaterThanOrEqual(2);
    task.stop();
  });

  it("stop() prevents further calls", async () => {
    const task = new RecurringTask("test", fn, 30, { runImmediately: true });
    task.start();

    await new Promise((r) => setTimeout(r, 10));
    const countAfterStart = fn.mock.calls.length;

    task.stop();

    await new Promise((r) => setTimeout(r, 80));
    expect(fn.mock.calls.length).toBe(countAfterStart);
  });
});
