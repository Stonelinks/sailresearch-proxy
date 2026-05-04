/**
 * Shared per-route preamble: auth check, JSON body parse, model validation,
 * and completion-window resolution. Three POST routes (chat-completions,
 * messages, responses) previously each carried their own ~30 lines doing
 * all of this — including a subtle inconsistency where chat-completions
 * didn't accept the Anthropic-style `x-api-key` header.
 */
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { openAIError } from "../errors.ts";
import { resolveCompletionWindow } from "../completion-window.ts";
import { now, formatDuration } from "../../shared/time.ts";
import type { CompletionWindow } from "../types.ts";

export interface ParsedRequest {
  body: any;
  completionWindow: CompletionWindow;
  windowSource: string;
}

export type ParseResult = { error: Response } | { ok: ParsedRequest };

export interface ParseOpts {
  /** Used in log prefixes — e.g. "chat-completions", "messages". */
  routeName: string;
  /** Window prefix from the URL (e.g. /priority/v1/...). null when unprefixed. */
  urlPrefix: CompletionWindow | null;
}

/**
 * Validate auth, parse the JSON body, check for required `model`, and resolve
 * the completion window. Returns a Response on failure that the caller should
 * return to the client unchanged. Caller-specific body validation (e.g.
 * `messages` non-empty array) stays at the call site, since the error
 * messages are API-shape-specific.
 */
export async function parseRequest(
  req: Request,
  opts: ParseOpts,
): Promise<ParseResult> {
  if (config.proxyApiKey) {
    const auth = req.headers.get("authorization");
    const xApiKey = req.headers.get("x-api-key");
    const token = auth?.replace(/^Bearer\s+/i, "") ?? xApiKey;
    if (token !== config.proxyApiKey) {
      log.warn(`[${opts.routeName}] auth rejected: invalid api key`);
      return {
        error: openAIError(401, "Invalid API key", "authentication_error"),
      };
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    log.debug(`[${opts.routeName}] invalid JSON body`);
    return {
      error: openAIError(400, "Invalid JSON body", "invalid_request_error"),
    };
  }

  if (!body.model) {
    return {
      error: openAIError(
        400,
        "model is required",
        "invalid_request_error",
        "model",
      ),
    };
  }

  const headerWindow = req.headers.get("x-completion-window");
  const { window: completionWindow, source: windowSource } =
    resolveCompletionWindow(
      opts.urlPrefix,
      headerWindow,
      body.metadata,
      config.defaults.completionWindow,
    );

  return { ok: { body, completionWindow, windowSource } };
}

/**
 * Wrap a route handler with start/end log lines and timing. Replaces three
 * near-identical inline arrow blocks in app.ts.
 */
export function wrapRouteLogging(
  routePath: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const start = now();
    log.info(`[req] ${req.method} ${routePath}`);
    const res = await handler(req);
    log.info(
      `[res] ${req.method} ${routePath} ${res.status} ${formatDuration(now() - start)}`,
    );
    return res;
  };
}
