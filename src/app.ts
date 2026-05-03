import { config } from "./config.ts";
import { log } from "../shared/logger.ts";
import { now } from "../shared/time.ts";
import { Poller } from "./services/poller.ts";
import { Pruner } from "./services/pruner.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleModels } from "./routes/models.ts";
import { handleMessages } from "./routes/messages.ts";
import { handleResponses } from "./routes/responses.ts";
import {
  handleDashboardJobs,
  handleDashboardJobDetail,
  handleDashboardModels,
  registerDashboardClient,
  unregisterDashboardClient,
  type WSDashboardData,
} from "./routes/dashboard-api.ts";
import { openAIError } from "./errors.ts";
import { handleWindowPrefixedRoute } from "./router.ts";
import path from "node:path";
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { ServerWebSocket } from "bun";

const SPA_DIR = path.resolve(import.meta.dir, "../frontend/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveSPA(req: Request): Response {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Only serve GET requests for non-API, non-WS paths
  if (
    req.method !== "GET" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ws/")
  ) {
    return openAIError(404, "Not found", "invalid_request_error");
  }

  // Try to serve a static file
  const filePath = path.join(SPA_DIR, pathname);
  // Prevent path traversal
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(SPA_DIR)) {
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        const ext = path.extname(resolved);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        // Vite hashes asset filenames — these can be cached forever.
        // index.html must never be cached so the browser picks up new builds.
        const isImmutable =
          pathname.startsWith("/assets/") && /-[a-zA-Z0-9]{6,}/.test(pathname);
        const headers: Record<string, string> = { "Content-Type": contentType };
        if (isImmutable) {
          headers["Cache-Control"] = "public, max-age=31536000, immutable";
        } else {
          headers["Cache-Control"] = "no-cache";
        }
        return new Response(Bun.file(resolved), { headers });
      }
    } catch {
      // File not found, fall through to SPA fallback
    }
  }

  // SPA fallback: serve index.html for any unmatched route
  const indexPath = path.join(SPA_DIR, "index.html");
  try {
    return new Response(Bun.file(indexPath), {
      headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
    });
  } catch {
    return openAIError(404, "Not found", "invalid_request_error");
  }
}

export interface AppServer {
  server: ReturnType<typeof Bun.serve>;
  poller: Poller;
  pruner: Pruner;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

export function createApp(prisma: PrismaClient, port?: number): AppServer {
  const poller = new Poller(prisma);
  poller.start();

  const pruner = new Pruner(prisma);
  pruner.start();

  const server = Bun.serve({
    port: port ?? config.server.port,
    hostname: config.server.host,
    idleTimeout: 255,

    websocket: {
      data: {} as WSDashboardData,

      open(ws: ServerWebSocket<WSDashboardData>) {
        registerDashboardClient(ws);
      },

      message(
        ws: ServerWebSocket<WSDashboardData>,
        message: string | ArrayBuffer | Uint8Array,
      ) {
        // Dashboard WS is server-push only; ignore incoming messages
      },

      close(ws: ServerWebSocket<WSDashboardData>) {
        unregisterDashboardClient(ws);
      },
    },

    routes: {
      "/v1/chat/completions": {
        POST: (req) => {
          const start = now();
          log.info(`[req] POST /v1/chat/completions`);
          return handleChatCompletions(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/chat/completions ${res.status} ${now() - start}ms`,
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
          const start = now();
          log.info(`[req] POST /v1/messages`);
          return handleMessages(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/messages ${res.status} ${now() - start}ms`,
            );
            return res;
          });
        },
      },
      "/v1/responses": {
        POST: (req) => {
          const start = now();
          log.info(`[req] POST /v1/responses`);
          return handleResponses(req, poller).then((res) => {
            log.info(
              `[res] POST /v1/responses ${res.status} ${now() - start}ms`,
            );
            return res;
          });
        },
      },
      "/health": new Response("ok"),
      "/api/dashboard/jobs": {
        GET: (req) => handleDashboardJobs(req),
      },
      "/api/models": {
        GET: () => handleDashboardModels(),
      },
    },

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for dashboard real-time updates
      if (
        url.pathname === "/ws/dashboard" &&
        server.upgrade(req, {
          data: { subscribedAt: Date.now() } as WSDashboardData,
        })
      ) {
        return; // upgrade succeeded, do not return a Response
      }

      // Try window-prefixed routes first
      const windowResult = handleWindowPrefixedRoute(req, poller);
      if (windowResult) return windowResult;

      // Dashboard API: job detail
      if (
        url.pathname.startsWith("/api/dashboard/jobs/") &&
        req.method === "GET"
      ) {
        return handleDashboardJobDetail(req);
      }

      // Serve SPA static files
      return serveSPA(req);
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
    pruner,
    prisma,
    async stop() {
      log.info("[shutdown] stopping...");
      poller.stop();
      pruner.stop();
      await prisma.$disconnect();
      server.stop();
    },
  };
}
