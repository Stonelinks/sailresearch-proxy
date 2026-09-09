import {
  normalizeCompletionWindow,
  rawWindowPrefix,
} from "../completion-window.ts";
import { log } from "../../shared/logger.ts";
import type { CompletionWindow } from "../types.ts";

export interface RewriteResult {
  /** Stripped pathname (e.g. "/v1/chat/completions"). */
  pathname: string;
  /** Request with the prefix removed and X-Completion-Window injected. */
  req: Request;
  /** The detected window prefix (legacy names already aliased). */
  prefix: CompletionWindow;
}

/**
 * If `req` targets a window-prefixed route (e.g. /flex/v1/chat/completions),
 * rewrite the URL to drop the prefix and inject `X-Completion-Window`. Retired
 * prefixes (/priority, /standard) are accepted and aliased to their current
 * window. Returns null if the path is not a valid window-prefixed route —
 * caller should dispatch the request unchanged.
 */
export function rewriteForWindowPrefix(req: Request): RewriteResult | null {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const segment = rawWindowPrefix(pathname);
  if (!segment) return null;
  const prefix = normalizeCompletionWindow(segment);
  if (!prefix) return null;

  const stripped = pathname.slice(`/${segment}`.length);
  log.info(
    `[req] ${req.method} ${pathname} -> window=${prefix} rewrite=${stripped}`,
  );

  const newUrl = new URL(stripped, url.origin);
  const headers = new Headers(req.headers);
  headers.set("x-completion-window", prefix);
  // `duplex: "half"` is required when streaming a Request body but isn't
  // yet in the lib.dom RequestInit type; cast keeps the runtime field.
  const init: RequestInit & { duplex?: "half" | "full" } = {
    method: req.method,
    headers,
  };
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    init.body = req.body;
    init.duplex = "half";
  }
  return {
    pathname: stripped,
    req: new Request(newUrl.toString(), init),
    prefix,
  };
}
