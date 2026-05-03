/**
 * Tests for Poller's multi-waiter API. The historical bug:
 * `waiters` was `Map<string, JobWaiter>`, so two concurrent dedup-hit
 * requests on the same sailResponseId would clobber each other's promise —
 * the first request would hang until its window timeout (5–60 min).
 *
 * The contract being verified here:
 *  1. Multiple `registerWaiter(sameId)` calls each get their own promise;
 *     resolving the job resolves ALL of them.
 *  2. The `cancel` handle removes only the specific waiter that called it,
 *     leaving sibling waiters on the same id intact.
 *  3. Rejecting a job rejects all waiters; stop() rejects all waiters.
 */
import { describe, test, expect } from "bun:test";
import { Poller } from "./poller.ts";

describe("Poller multi-waiter API", () => {
  test("two waiters on the same id both resolve when the job completes", async () => {
    const poller = new Poller({} as any);
    const w1 = poller.registerWaiter("job-a");
    const w2 = poller.registerWaiter("job-a");

    // Distinct promises — no clobbering.
    expect(w1.promise).not.toBe(w2.promise);

    // Drive the resolve path the same way the poller does.
    (
      poller as unknown as {
        resolveWaiters: (id: string, data: any) => void;
      }
    ).resolveWaiters("job-a", { ok: 1 });

    const [r1, r2] = await Promise.all([w1.promise, w2.promise]);
    expect(r1).toEqual({ ok: 1 });
    expect(r2).toEqual({ ok: 1 });
  }, 2000);

  test("rejecting the job rejects every waiter for it", async () => {
    const poller = new Poller({} as any);
    const w1 = poller.registerWaiter("job-b");
    const w2 = poller.registerWaiter("job-b");

    (
      poller as unknown as {
        rejectWaiters: (id: string, err: any) => void;
      }
    ).rejectWaiters("job-b", { error: { message: "boom" } });

    await expect(w1.promise).rejects.toMatchObject({
      error: { message: "boom" },
    });
    await expect(w2.promise).rejects.toMatchObject({
      error: { message: "boom" },
    });
  }, 2000);

  test("cancel() removes only the calling waiter; siblings still resolve", async () => {
    const poller = new Poller({} as any);
    const w1 = poller.registerWaiter("job-c");
    const w2 = poller.registerWaiter("job-c");

    // Cancel w1; w2 must still resolve when the job completes.
    w1.cancel();

    (
      poller as unknown as {
        resolveWaiters: (id: string, data: any) => void;
      }
    ).resolveWaiters("job-c", { good: true });

    expect(await w2.promise).toEqual({ good: true });

    // w1 was cancelled before the resolve fired; its promise stays pending
    // forever, which is fine — the caller (waitForJob) raced it against a
    // timeout. We can't await an indefinitely-pending promise; instead,
    // verify by racing against a microtask that w1 has not resolved.
    const sentinel = Symbol("pending");
    const result = await Promise.race([
      w1.promise.then((v) => v).catch(() => sentinel),
      Promise.resolve(sentinel),
    ]);
    expect(result).toBe(sentinel);
  }, 2000);

  test("cancel() is idempotent and safe after the job already settled", () => {
    const poller = new Poller({} as any);
    const w = poller.registerWaiter("job-d");
    (
      poller as unknown as {
        resolveWaiters: (id: string, data: any) => void;
      }
    ).resolveWaiters("job-d", { ok: 1 });
    // Should not throw — the waiter has already been removed by resolveWaiters.
    expect(() => w.cancel()).not.toThrow();
    expect(() => w.cancel()).not.toThrow();
  }, 2000);

  test("stop() rejects waiters for every job", async () => {
    const poller = new Poller({} as any);
    const w1 = poller.registerWaiter("job-e");
    const w2 = poller.registerWaiter("job-f");
    const w3 = poller.registerWaiter("job-f"); // sibling on job-f

    poller.stop();

    await expect(w1.promise).rejects.toThrow("Poller stopped");
    await expect(w2.promise).rejects.toThrow("Poller stopped");
    await expect(w3.promise).rejects.toThrow("Poller stopped");
  }, 2000);
});
