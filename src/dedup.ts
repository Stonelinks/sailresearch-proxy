import type { PrismaClient } from "@prisma/client";

/**
 * Deterministically serialize a value to JSON with sorted keys.
 * This ensures that objects with the same keys in different order
 * produce the same string (and therefore the same hash).
 */
export function deterministicStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => deterministicStringify(v)).join(",") + "]";
  }

  // Sort object keys for determinism
  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ":" + deterministicStringify(value[k]),
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Compute a SHA-256 hash of the Sail request body.
 * This is the dedup key — two requests that produce the same
 * Sail body map to the same unit of work.
 */
export function computeSailBodyHash(sailBody: any): string {
  const serialized = deterministicStringify(sailBody);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serialized);
  return hasher.digest("hex");
}

/**
 * Find an existing non-failed/non-cancelled job matching the given hash.
 * Returns the most recently created match, or null if none found.
 */
export async function findExistingJob(
  db: PrismaClient,
  hash: string,
): Promise<any | null> {
  const jobs = await db.pendingJob.findMany({
    where: {
      sailBodyHash: hash,
      status: { notIn: ["failed", "cancelled"] },
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return jobs[0] ?? null;
}
