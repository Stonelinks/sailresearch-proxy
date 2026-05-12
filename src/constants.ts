/**
 * Centralised business-logic constants. Single source of truth for values
 * that were previously scattered across multiple files or duplicated inline.
 *
 * Env-driven config lives in `config.ts`; time helpers in `shared/time.ts`.
 */

import type { CompletionWindow } from "./types.ts";

// ── Job statuses ────────────────────────────────────────────────────────

/** Job statuses that represent a terminal state — no further polling needed. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

// ── SSE streaming ───────────────────────────────────────────────────────

/** Headers for Server-Sent Events responses (chat-completions streaming). */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

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

// ── Poller backoff ──────────────────────────────────────────────────────

/** Backoff thresholds (ms) indexed by poll-count zone. */
export const BACKOFF_THRESHOLDS = {
  fast: 2_000, // polls 0–2
  medium: 5_000, // polls 3–5
  slow: 10_000, // polls 6–20
  floor: 30_000, // polls 21+
} as const;

/** Poll-count boundaries that select the backoff zone. */
export const BACKOFF_BOUNDARIES = {
  fastMax: 3, // pollCount < this → fast
  mediumMax: 6, // pollCount < this → medium
  slowMax: 21, // pollCount < this → slow
} as const;

// ── SSE keep-alive ─────────────────────────────────────────────────────

/** How often to emit SSE comment heartbeats on long-running batched streams. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

// ── Batch submit ────────────────────────────────────────────────────────

/** How often to re-poll the DB as a safety net for missed waiter notifications. */
export const PERIODIC_RECHECK_MS = 5_000;
