import { prisma } from "./db.ts";
import { config } from "./config.ts";
import { Poller } from "./services/poller.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleModels } from "./routes/models.ts";
import { openAIError } from "./errors.ts";

// Run migrations / ensure DB schema
const migrateResult = Bun.spawnSync(
  ["bunx", "prisma", "db", "push", "--skip-generate"],
  { env: process.env, cwd: import.meta.dir + "/.." },
);
if (migrateResult.exitCode !== 0) {
  console.error(
    "[startup] prisma db push failed:",
    migrateResult.stderr.toString(),
  );
  process.exit(1);
}

// Check for in-flight jobs from previous run
const resumed = await prisma.pendingJob.count({
  where: { status: { notIn: ["completed", "failed", "cancelled"] } },
});
if (resumed > 0) {
  console.log(`[startup] resuming ${resumed} in-flight job(s)`);
}

// Start poller
const poller = new Poller(prisma);
poller.start();

const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.host,
  idleTimeout: 255,

  routes: {
    "/v1/chat/completions": {
      POST: (req) => {
        const start = Date.now();
        console.log(`[req] POST /v1/chat/completions`);
        return handleChatCompletions(req, poller).then((res) => {
          console.log(
            `[res] POST /v1/chat/completions ${res.status} ${Date.now() - start}ms`,
          );
          return res;
        });
      },
    },
    "/v1/models": {
      GET: () => handleModels(),
    },
    "/health": new Response("ok"),
  },

  fetch(req) {
    console.log(`[req] ${req.method} ${new URL(req.url).pathname} -> 404`);
    return openAIError(404, "Not found", "invalid_request_error");
  },

  error(error) {
    console.error("[server] unhandled error:", error);
    return openAIError(500, "Internal server error");
  },
});

console.log(
  `[startup] sail proxy listening on http://${config.server.host}:${config.server.port}`,
);

// Graceful shutdown
async function shutdown() {
  console.log("\n[shutdown] stopping...");
  poller.stop();
  await prisma.$disconnect();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
