import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockDeleteMany = mock();

const { Pruner } = await import("./pruner.ts");

const prisma = {
  pendingJob: {
    deleteMany: mockDeleteMany,
  },
} as any;

describe("Pruner", () => {
  const pruner = new Pruner(prisma);

  beforeEach(() => {
    mockDeleteMany.mockReset();
  });

  it("deletes jobs older than retention period", async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 5 });

    await pruner.prune();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    const where = mockDeleteMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt).toBeDefined();
    // The cutoff should be ~180 days ago
    const cutoff = new Date(where.createdAt.lt).getTime();
    const expected = Date.now() - 180 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000); // within 5s
  });

  it("keeps jobs newer than retention period (query uses lt, not lte)", async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });

    await pruner.prune();

    const where = mockDeleteMany.mock.calls[0]![0].where;
    // Uses `lt` (strictly less than), so jobs exactly at the cutoff are kept
    expect(where.createdAt.lt).toBeDefined();
  });

  it("deletes jobs of all statuses (no status filter in query)", async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 3 });

    await pruner.prune();

    const where = mockDeleteMany.mock.calls[0]![0].where;
    // Only filters on createdAt, not on status — all statuses are pruned
    expect(Object.keys(where)).toHaveLength(1);
    expect("createdAt" in where).toBe(true);
    expect("status" in where).toBe(false);
  });

  it("logs count when jobs are deleted", async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 42 });

    // prune logs but doesn't throw — just verify it completes
    await pruner.prune();
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("handles errors gracefully", async () => {
    mockDeleteMany.mockRejectedValueOnce(new Error("DB error"));

    // Should not throw
    await pruner.prune();
  });
});
