/**
 * Centralised business-logic constants. Single source of truth for values
 * that were previously scattered across multiple files or duplicated inline.
 *
 * Env-driven config lives in `config.ts`; time helpers in `shared/time.ts`.
 */

import type { CompletionWindow } from "./types.ts";

// ── Completion window → provider name ───────────────────────────────────

/** Maps each completion window to its pi models.json provider name. */
export const WINDOW_PROVIDER_NAMES: Record<CompletionWindow, string> = {
  asap: "sail-asap",
  balanced: "sail-balanced",
  flex: "sail-flex",
};

/**
 * Convenience provider that targets the proxy's bare `/v1` route, i.e.
 * whatever `DEFAULT_COMPLETION_WINDOW` resolves to (balanced by default).
 */
export const DEFAULT_PROVIDER = "sail";

// ── Token pricing ───────────────────────────────────────────────────────

/** Number of tokens in one "per-MTok" pricing unit. */
export const PER_MTOKEN = 1_000_000;
