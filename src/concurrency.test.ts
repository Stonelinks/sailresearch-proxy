import { test, expect, describe } from "bun:test";
import { mapSettledWithLimit } from "./concurrency.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("mapSettledWithLimit", () => {
  test("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    const results = await mapSettledWithLimit(items, 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    ).toEqual([60, 20, 40, 10]);
  });

  test("passes the index to the worker", async () => {
    const items = ["a", "b", "c"];
    const results = await mapSettledWithLimit(
      items,
      2,
      async (item, i) => `${i}:${item}`,
    );
    expect(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    ).toEqual(["0:a", "1:b", "2:c"]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapSettledWithLimit(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return i;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3); // 12 items / limit 3 → pool fully saturated
  });

  test("actually runs in parallel up to the limit", async () => {
    // 4 items, each sleeps 20ms, limit 4 → ~one batch, well under 80ms serial.
    const items = [0, 1, 2, 3];
    const start = performance.now();
    await mapSettledWithLimit(items, 4, async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(60);
  });

  test("a rejection does not abort the batch; others still run", async () => {
    const items = [1, 2, 3, 4];
    const results = await mapSettledWithLimit(items, 2, async (n) => {
      if (n === 2) throw new Error(`boom ${n}`);
      return n * 10;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]!.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("boom 2");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
    expect(results[3]).toEqual({ status: "fulfilled", value: 40 });
  });

  test("empty input resolves to an empty array without calling the worker", async () => {
    let called = false;
    const results = await mapSettledWithLimit([], 4, async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  test("limit larger than item count just runs everything at once", async () => {
    const items = [1, 2, 3];
    const results = await mapSettledWithLimit(items, 100, async (n) => n);
    expect(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    ).toEqual([1, 2, 3]);
  });

  test.each([0, -5, NaN, Infinity])(
    "non-positive / non-finite limit (%p) falls back to sequential",
    async (badLimit) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const items = [1, 2, 3, 4];

      const results = await mapSettledWithLimit(
        items,
        badLimit as number,
        async (n) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick();
          inFlight--;
          return n;
        },
      );

      expect(maxInFlight).toBe(1);
      expect(
        results.map((r) => (r.status === "fulfilled" ? r.value : null)),
      ).toEqual([1, 2, 3, 4]);
    },
  );
});
