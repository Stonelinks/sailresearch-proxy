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
  priority: "sail-priority",
  standard: "sail-standard",
  flex: "sail-flex",
};

// ── Token pricing ───────────────────────────────────────────────────────

/** Number of tokens in one "per-MTok" pricing unit. */
export const PER_MTOKEN = 1_000_000;

// ── Pi SDK defaults ─────────────────────────────────────────────────────

/** Default provider name for the pi SDK session. */
export const DEFAULT_PROVIDER = "sail-standard";
