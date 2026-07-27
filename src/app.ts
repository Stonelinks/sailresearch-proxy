import { config } from "./config.ts";
import { log } from "../shared/logger.ts";
import {
  handleChatCompletions,
  handleMessages,
  handleResponses,
} from "./routes/api-forward.ts";
import { handleModels } from "./routes/models.ts";
import { handleVersion } from "./routes/version.ts";
import { wrapRouteLogging } from "./routes/parse-request.ts";
import { openAIError } from "./errors.ts";
import { rewriteForWindowPrefix } from "./routes/dispatch.ts";
import { createGraphQLYoga } from "./graphql/yoga.ts";
import { schema as gqlSchema } from "./graphql/schema.ts";
import { pubsub } from "./graphql/pubsub.ts";
import { handleProtocols, makeHandler } from "graphql-ws/use/bun";
import path from "node:path";
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { Context } from "./graphql/builder.ts";

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

  // Only serve GET requests for non-API, non-graphql paths
  if (
    req.method !== "GET" ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/graphql") ||
    pathname.startsWith("/api/")
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
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

export function createApp(prisma: PrismaClient, port?: number): AppServer {
  const yoga = createGraphQLYoga(prisma);
  const wsHandler = makeHandler({
    schema: gqlSchema,
    context: () => ({ prisma, pubsub }) satisfies Context,
  });

  // Pre-build per-route logging wrappers once; allocating new wrappers per
  // request would defeat the point of the wrapper closure.
  const chatRoute = wrapRouteLogging("/v1/chat/completions", (req) =>
    handleChatCompletions(req),
  );
  const messagesRoute = wrapRouteLogging("/v1/messages", (req) =>
    handleMessages(req),
  );
  const responsesRoute = wrapRouteLogging("/v1/responses", (req) =>
    handleResponses(req),
  );

  function dispatch(
    req: Request,
    pathname: string,
  ): Response | Promise<Response> {
    if (pathname === "/v1/chat/completions" && req.method === "POST")
      return chatRoute(req);
    if (pathname === "/v1/models" && req.method === "GET")
      return handleModels(req);
    if (pathname === "/v1/messages" && req.method === "POST")
      return messagesRoute(req);
    if (pathname === "/v1/responses" && req.method === "POST")
      return responsesRoute(req);
    return openAIError(404, "Not found", "invalid_request_error");
  }

  const server = Bun.serve({
    port: port ?? config.server.port,
    hostname: config.server.host,
    // Bun's max idle timeout is 255 seconds. Streaming requests stay alive
    // as long as Sail emits bytes (its /messages SSE includes pings); a
    // non-streaming request on a batched window that sits silent past 255s
    // will be cut — clients should use `stream: true` for long waits.
    idleTimeout: 255,

    websocket: wsHandler,

    fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // GraphQL — single endpoint serves both HTTP queries/mutations and
      // WebSocket subscriptions. The graphql-ws Bun adapter validates the
      // sec-websocket-protocol header and refuses non-graphql upgrades.
      if (pathname === "/graphql") {
        if (req.headers.get("upgrade") === "websocket") {
          if (
            !handleProtocols(req.headers.get("sec-websocket-protocol") || "")
          ) {
            return new Response("Bad Request", { status: 400 });
          }
          if (!server.upgrade(req)) {
            return new Response("Upgrade Failed", { status: 500 });
          }
          return undefined as unknown as Response; // upgrade succeeded
        }
        return yoga(req);
      }

      // Window-prefixed routes (e.g. /flex/v1/chat/completions): strip the
      // prefix, inject X-Completion-Window, then dispatch as if unprefixed.
      const rewritten = rewriteForWindowPrefix(req);
      if (rewritten) {
        return dispatch(rewritten.req, rewritten.pathname);
      }

      // /v1/* and /v1/models — delegate to dispatch
      if (pathname.startsWith("/v1/")) return dispatch(req, pathname);

      // API
      if (pathname === "/api/version" && req.method === "GET")
        return handleVersion(req);

      // Health
      if (pathname === "/health") return new Response("ok");

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
    prisma,
    async stop() {
      log.info("[shutdown] stopping...");
      await prisma.$disconnect();
      server.stop();
    },
  };
}
