import type { CompletionWindow } from "./types.ts";

/** All valid CompletionWindow values, derived from the type. */
export const COMPLETION_WINDOWS: readonly CompletionWindow[] = [
  "asap",
  "priority",
  "standard",
  "flex",
];

/** Check if a string is a valid CompletionWindow value. */
export function isValidCompletionWindow(value: string): value is CompletionWindow {
  return (COMPLETION_WINDOWS as readonly string[]).includes(value);
}

/**
 * Extract the completion window prefix from a URL path.
 * e.g. "/asap/v1/chat/completions" → "asap"
 *      "/v1/chat/completions"      → null
 */
export function extractWindowPrefix(pathname: string): CompletionWindow | null {
  const match = pathname.match(/^\/([a-z]+)\/v1\//);
  if (!match) return null;
  const candidate = match[1]!;
  return isValidCompletionWindow(candidate) ? candidate : null;
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
 * Returns the resolved window and which source won.
 */
export function resolveCompletionWindow(
  urlPrefix: CompletionWindow | null,
  header: string | null,
  bodyMetadata: { completion_window?: string } | undefined,
  defaultWindow: CompletionWindow,
): { window: CompletionWindow; source: "prefix" | "header" | "metadata" | "default" } {
  if (urlPrefix) return { window: urlPrefix, source: "prefix" };
  if (header) return { window: header as CompletionWindow, source: "header" };
  if (bodyMetadata?.completion_window)
    return { window: bodyMetadata.completion_window as CompletionWindow, source: "metadata" };
  return { window: defaultWindow, source: "default" };
}
