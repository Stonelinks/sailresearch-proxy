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
export const SIXTY_MINUTES = 60 * MINUTE;

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
