import { log } from "./logger.ts";
import { openAIError } from "./errors.ts";
import { extractWindowPrefix } from "./completion-window.ts";
import type { Poller } from "./services/poller.ts";
import type { CompletionWindow } from "./types.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleModels } from "./routes/models.ts";
import { handleMessages } from "./routes/messages.ts";

/**
 * Dispatch a request to the appropriate route handler based on pathname.
 * Used both by Bun.serve routes and by the window-prefix rewriting in fetch().
 */
export function dispatchRoute(
  req: Request,
  pathname: string,
  poller: Poller,
): Response | Promise<Response> {
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, poller);
  }
  if (pathname === "/v1/models" && req.method === "GET") {
    return handleModels();
  }
  if (pathname === "/v1/messages" && req.method === "POST") {
    return handleMessages(req);
  }
  return openAIError(404, "Not found", "invalid_request_error");
}

/**
 * Handle a window-prefixed request by extracting the prefix,
 * rewriting the URL, injecting the X-Completion-Window header,
 * and dispatching to the stripped route.
 *
 * Returns null if the path is not a valid window-prefixed route.
 */
export function handleWindowPrefixedRoute(
  req: Request,
  poller: Poller,
): Response | Promise<Response> | null {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const windowPrefix = extractWindowPrefix(pathname);
  if (!windowPrefix) return null;

  const strippedPath = pathname.replace(`/${windowPrefix}`, "");
  log.info(
    `[req] ${req.method} ${pathname} -> window=${windowPrefix} rewrite=${strippedPath}`,
  );

  // Build a new request with the rewritten URL and injected header
  const newUrl = new URL(strippedPath, url.origin);
  const headers = new Headers(req.headers);
  headers.set("x-completion-window", windowPrefix);

  // Only forward body for methods that have one
  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    init.body = req.body;
    init.duplex = "half";
  }

  const rewritten = new Request(newUrl.toString(), init);

  return dispatchRoute(rewritten, strippedPath, poller);
}
