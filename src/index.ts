import { PrismaClient } from "@prisma/client";
import { log, initFileLogging, closeFileLogging } from "../shared/logger.ts";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import fs from "node:fs";

// Initialize file logging before anything else
fs.mkdirSync(config.logging.dir, { recursive: true });
initFileLogging(config.logging.dir);

// Apply committed migrations
const migrateResult = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
  env: process.env,
  cwd: import.meta.dir + "/..",
});
if (migrateResult.exitCode !== 0) {
  log.error(
    "[startup] prisma migrate deploy failed:",
    migrateResult.stderr.toString(),
  );
  process.exit(1);
}

const prisma = new PrismaClient();

const app = createApp(prisma);

// Graceful shutdown
async function shutdown() {
  closeFileLogging();
  await app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
