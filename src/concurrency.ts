/**
 * Bounded-concurrency helpers — run async work over a list of items with a
 * cap on how many run at once (a simple worker pool).
 *
 * Use these instead of an unbounded `Promise.all` / `Promise.allSettled`
 * fan-out when the work hits a shared resource (the proxy, an upstream API)
 * that you don't want to flood.
 */

/**
 * Map `worker` over `items` with at most `limit` calls in flight at once.
 *
 * Results are returned in the SAME order as `items`, as
 * `PromiseSettledResult`s — a single rejection does not abort the batch, so
 * this is a drop-in for `Promise.allSettled(items.map(worker))` that also
 * bounds concurrency.
 *
 * `limit` is clamped to `[1, items.length]`. A non-positive or non-finite
 * limit is treated as 1 (fully sequential).
 */
export async function mapSettledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);

  if (items.length === 0) return results;

  // Shared cursor: each worker pulls the next index until the list is drained.
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await worker(items[i]!, i);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  const safeLimit =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const workerCount = Math.min(safeLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results;
}
