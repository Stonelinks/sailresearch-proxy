import { describe, it, expect, mock, beforeEach } from "bun:test";
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

  it("waits for interval before first call", async () => {
    const task = new RecurringTask("test", fn, 100);
    task.start();

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(0);

    await new Promise((r) => setTimeout(r, 150));
    expect(fn).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("waits full interval after a slow fn completes", async () => {
    const slowFn = mock(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const task = new RecurringTask("test", slowFn, 50);
    task.start();

    // First call fires at ~50ms, takes 100ms → completes at ~150ms.
    // Second call schedules at ~150ms, fires at ~200ms.
    await new Promise((r) => setTimeout(r, 180));
    expect(slowFn).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 200));
    expect(slowFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    task.stop();
  });

  it("continues loop after fn throws", async () => {
    let callCount = 0;
    const failingFn = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
    });

    const task = new RecurringTask("test", failingFn, 50);
    task.start();

    await new Promise((r) => setTimeout(r, 250));
    expect(callCount).toBeGreaterThanOrEqual(2);
    task.stop();
  });

  it("stop() prevents further calls", async () => {
    const task = new RecurringTask("test", fn, 50);
    task.start();

    // Wait long enough for at least one fire.
    await new Promise((r) => setTimeout(r, 120));
    const countAfterStart = fn.mock.calls.length;
    expect(countAfterStart).toBeGreaterThan(0);

    task.stop();

    await new Promise((r) => setTimeout(r, 200));
    expect(fn.mock.calls.length).toBe(countAfterStart);
  });

  it("running getter reflects start/stop state", () => {
    const task = new RecurringTask("test", fn, 1000);
    expect(task.running).toBe(false);
    task.start();
    expect(task.running).toBe(true);
    task.stop();
    expect(task.running).toBe(false);
  });

  it("start() is idempotent", () => {
    const task = new RecurringTask("test", fn, 1000);
    task.start();
    task.start();
    expect(task.running).toBe(true);
    task.stop();
  });
});
