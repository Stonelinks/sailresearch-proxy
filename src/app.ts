import { config } from "./config.ts";
import { log } from "./logger.ts";
import { Poller } from "./services/poller.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleModels } from "./routes/models.ts";
import { handleMessages } from "./routes/messages.ts";
import { handleResponses } from "./routes/responses.ts";
import { handleDashboardJobs } from "./routes/dashboard-api.ts";
import { openAIError } from "./errors.ts";
import dashboard from "./dashboard/dashboard.html";
import { handleWindowPrefixedRoute } from "./router.ts";
import type { PrismaClient } from "@prisma/client";

export interface AppServer {
  server: ReturnType<typeof Bun.serve>;
  poller: Poller;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

export function createApp(prisma: PrismaClient, port?: number): AppServer {
  const poller = new Poller(prisma);
  poller.start();

  const server = Bun.serve({
    port: port ?? config.server.port,
    hostname: config.server.host,
    idleTimeout: 255,

    routes: {
      "/v1/chat/completions": {
        POST: (req) => {
          const start = Date.now();
          log.info(`[req] POST /v1/chat/completions`);
          return handleChatCompletions(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/chat/completions ${res.status} ${Date.now() - start}ms`,
            );
            return res;
          });
        },
      },
      "/v1/models": {
        GET: () => handleModels(),
      },
      "/v1/messages": {
        POST: (req) => {
          const start = Date.now();
          log.info(`[req] POST /v1/messages`);
          return handleMessages(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/messages ${res.status} ${Date.now() - start}ms`,
            );
            return res;
          });
        },
      },
      "/v1/responses": {
        POST: (req) => {
          const start = Date.now();
          log.info(`[req] POST /v1/responses`);
          return handleResponses(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/responses ${res.status} ${Date.now() - start}ms`,
            );
            return res;
          });
        },
      },
      "/health": new Response("ok"),
      "/dashboard": dashboard,
      "/api/dashboard/jobs": {
        GET: (req) => handleDashboardJobs(req),
      },
    },

    fetch(req) {
      // Try window-prefixed routes first
      const windowResult = handleWindowPrefixedRoute(req, poller);
      if (windowResult) return windowResult;

      log.info(`[req] ${req.method} ${new URL(req.url).pathname} -> 404`);
      return openAIError(404, "Not found", "invalid_request_error");
    },

    error(error) {
      log.error("[server] unhandled error:", error);
      return openAIError(500, "Internal server error");
    },
  });

  log.info(
    `[startup] sail proxy listening on http://${config.server.host}:${server.port} logLevel=${config.logging.level}`,
  );

  return {
    server,
    poller,
    prisma,
    async stop() {
      log.info("[shutdown] stopping...");
      poller.stop();
      await prisma.$disconnect();
      server.stop();
    },
  };
}
