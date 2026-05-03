import { config } from "./config.ts";
import { log } from "../shared/logger.ts";
import { Poller } from "./services/poller.ts";
import { Pruner } from "./services/pruner.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleModels } from "./routes/models.ts";
import { handleMessages } from "./routes/messages.ts";
import { handleResponses } from "./routes/responses.ts";
import { wrapRouteLogging } from "./routes/parse-request.ts";
import {
  handleDashboardJobs,
  handleDashboardJobDetail,
  handleDashboardModels,
  registerDashboardClient,
  unregisterDashboardClient,
  type WSDashboardData,
} from "./routes/dashboard-api.ts";
import { openAIError } from "./errors.ts";
import { rewriteForWindowPrefix } from "./routes/dispatch.ts";
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

  // Pre-build per-route logging wrappers once; allocating new wrappers per
  // request would defeat the point of the wrapper closure.
  const chatRoute = wrapRouteLogging("/v1/chat/completions", (req) =>
    handleChatCompletions(req, poller),
  );
  const messagesRoute = wrapRouteLogging("/v1/messages", (req) =>
    handleMessages(req, poller),
  );
  const responsesRoute = wrapRouteLogging("/v1/responses", (req) =>
    handleResponses(req, poller),
  );

  function dispatch(
    req: Request,
    pathname: string,
  ): Response | Promise<Response> {
    if (pathname === "/v1/chat/completions" && req.method === "POST")
      return chatRoute(req);
    if (pathname === "/v1/models" && req.method === "GET")
      return handleModels();
    if (pathname === "/v1/messages" && req.method === "POST")
      return messagesRoute(req);
    if (pathname === "/v1/responses" && req.method === "POST")
      return responsesRoute(req);
    return openAIError(404, "Not found", "invalid_request_error");
  }

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

    fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade for dashboard real-time updates
      if (
        pathname === "/ws/dashboard" &&
        server.upgrade(req, {
          data: { subscribedAt: Date.now() } as WSDashboardData,
        })
      ) {
        return; // upgrade succeeded
      }

      // Window-prefixed routes (e.g. /flex/v1/chat/completions): strip the
      // prefix, inject X-Completion-Window, then dispatch as if unprefixed.
      const rewritten = rewriteForWindowPrefix(req);
      if (rewritten) {
        return dispatch(rewritten.req, rewritten.pathname);
      }

      // /v1/* and /v1/models — delegate to dispatch
      if (pathname.startsWith("/v1/")) return dispatch(req, pathname);

      // Health + dashboard API
      if (pathname === "/health") return new Response("ok");
      if (pathname === "/api/dashboard/jobs" && req.method === "GET")
        return handleDashboardJobs(req);
      if (pathname.startsWith("/api/dashboard/jobs/") && req.method === "GET")
        return handleDashboardJobDetail(req);
      if (pathname === "/api/models" && req.method === "GET")
        return handleDashboardModels();

      // SPA static files / fallback
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
