// ── Time constants ──────────────────────────────────────────────────────

/** 1 millisecond */
export const MS = 1;

/** 1 second in milliseconds */
export const SECOND = 1000 * MS;

/** 1 minute in milliseconds */
export const MINUTE = 60 * SECOND;

/** 1 hour in milliseconds */
export const HOUR = 60 * MINUTE;

/** 1 day in milliseconds */
export const DAY = 24 * HOUR;

// ── Convenience constants (used in config) ──────────────────────────────

export const FIVE_MINUTES = 5 * MINUTE;
export const FIFTEEN_MINUTES = 15 * MINUTE;
export const THIRTY_MINUTES = 30 * MINUTE;
export const SIXTY_MINUTES = 60 * MINUTE;
export const TWO_HOURS = 120 * MINUTE;

// ── Utility functions ───────────────────────────────────────────────────

/** Current wall-clock time in milliseconds. Single seam for all time access. */
export function now(): number {
  return Date.now();
}

/** Current wall-clock time as a Unix timestamp (seconds). */
export function unixNow(): number {
  return Math.floor(now() / SECOND);
}

/** Convert a Date to a Unix timestamp (seconds). */
export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / SECOND);
}

/** Convert a number of days to milliseconds. */
export function daysToMs(days: number): number {
  return days * DAY;
}

/** Return a Date representing `ms` milliseconds ago from now. */
export function msAgo(ms: number): Date {
  return new Date(now() - ms);
}

// ── Display formatters (used by Svelte components) ──────────────────────

/**
 * Human-readable duration. `ms === null` returns a status-aware placeholder:
 * a dash for terminal jobs, "in progress" otherwise.
 */
export function formatDuration(
  ms: number | null,
  status?: string,
): string {
  if (ms === null) {
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    )
      return "—";
    return "in progress";
  }
  if (ms < SECOND) return `${ms}ms`;
  const s = Math.floor(ms / SECOND);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** "just now", "5s ago", "3m ago", "2h ago", "4d ago". */
export function formatRelative(iso: string, nowMs: number = now()): string {
  const diff = nowMs - new Date(iso).getTime();
  const s = Math.floor(diff / SECOND);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
