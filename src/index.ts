import { PrismaClient } from "@prisma/client";
import { log } from "./logger.ts";
import { createApp } from "./app.ts";

// Run migrations / ensure DB schema
const migrateResult = Bun.spawnSync(
  ["bunx", "prisma", "db", "push", "--skip-generate"],
  { env: process.env, cwd: import.meta.dir + "/.." },
);
if (migrateResult.exitCode !== 0) {
  log.error(
    "[startup] prisma db push failed:",
    migrateResult.stderr.toString(),
  );
  process.exit(1);
}

const prisma = new PrismaClient();

// Check for in-flight jobs from previous run
const resumed = await prisma.pendingJob.count({
  where: { status: { notIn: ["completed", "failed", "cancelled"] } },
});
if (resumed > 0) {
  log.info(`[startup] resuming ${resumed} in-flight job(s)`);
}

const app = createApp(prisma);

// Graceful shutdown
async function shutdown() {
  await app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
