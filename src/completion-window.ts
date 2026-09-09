import type { CompletionWindow } from "./types.ts";
import { log } from "../shared/logger.ts";

/**
 * All valid CompletionWindow values, fastest first. Sail's current tiers are
 * documented at https://docs.sailresearch.com/completion-windows.
 */
export const COMPLETION_WINDOWS: readonly CompletionWindow[] = [
  "asap",
  "balanced",
  "flex",
];

/**
 * Retired Sail tiers and the current tier each one maps to. Sail returns a
 * 400 for these names (announced 2026-09), but clients configured before
 * the change may still send them; we rewrite rather than reject.
 */
export const LEGACY_WINDOW_ALIASES: Readonly<Record<string, CompletionWindow>> =
  {
    priority: "balanced",
    standard: "balanced",
  };

/** Check if a string is a valid CompletionWindow value. */
export function isValidCompletionWindow(
  value: string,
): value is CompletionWindow {
  return (COMPLETION_WINDOWS as readonly string[]).includes(value);
}

/**
 * Map a client-supplied window name to a current CompletionWindow.
 * Current names pass through; retired names are rewritten to their
 * replacement (with a warning); anything else returns null.
 */
export function normalizeCompletionWindow(
  value: string,
): CompletionWindow | null {
  if (isValidCompletionWindow(value)) return value;
  const alias = LEGACY_WINDOW_ALIASES[value];
  if (alias) {
    log.warn(
      `[window] legacy completion window "${value}" is retired; using "${alias}"`,
    );
    return alias;
  }
  return null;
}

const WINDOW_PREFIX_RE = /^\/([a-z]+)\/v1\//;

/**
 * Return the raw first path segment if the path looks window-prefixed
 * (`/{segment}/v1/...`), without validating it. Used by the dispatcher to
 * strip the prefix even when it is a legacy alias.
 */
export function rawWindowPrefix(pathname: string): string | null {
  const match = pathname.match(WINDOW_PREFIX_RE);
  return match ? match[1]! : null;
}

/**
 * Extract the completion window prefix from a URL path.
 * e.g. "/asap/v1/chat/completions"     → "asap"
 *      "/priority/v1/chat/completions" → "balanced" (legacy alias)
 *      "/v1/chat/completions"          → null
 */
export function extractWindowPrefix(pathname: string): CompletionWindow | null {
  const candidate = rawWindowPrefix(pathname);
  if (!candidate) return null;
  return normalizeCompletionWindow(candidate);
}

/**
 * Resolve the effective completion window from all possible sources.
 *
 * Priority order (highest first):
 *   1. URL prefix (e.g. /flex/v1/...)
 *   2. X-Completion-Window header
 *   3. metadata.completion_window in request body
 *   4. defaultWindow (from config)
 *
 * Header and body values are normalized (legacy names aliased); a value that
 * is neither current nor legacy is ignored and the next source is consulted.
 *
 * Returns the resolved window and which source won.
 */
export function resolveCompletionWindow(
  urlPrefix: CompletionWindow | null,
  header: string | null,
  bodyMetadata: { completion_window?: string } | undefined,
  defaultWindow: CompletionWindow,
): {
  window: CompletionWindow;
  source: "prefix" | "header" | "metadata" | "default";
} {
  if (urlPrefix) return { window: urlPrefix, source: "prefix" };
  if (header) {
    const w = normalizeCompletionWindow(header);
    if (w) return { window: w, source: "header" };
    log.warn(`[window] ignoring unknown X-Completion-Window "${header}"`);
  }
  const bodyWindow = bodyMetadata?.completion_window;
  if (bodyWindow) {
    const w = normalizeCompletionWindow(bodyWindow);
    if (w) return { window: w, source: "metadata" };
    log.warn(
      `[window] ignoring unknown metadata.completion_window "${bodyWindow}"`,
    );
  }
  return { window: defaultWindow, source: "default" };
}
