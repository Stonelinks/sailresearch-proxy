import { describe, test, expect } from "bun:test";
import { formatDuration, formatRelative, SECOND, MINUTE, HOUR, DAY } from "./time.ts";

describe("formatDuration", () => {
  test("renders sub-second durations as ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("renders sub-minute durations as seconds", () => {
    expect(formatDuration(SECOND)).toBe("1s");
    expect(formatDuration(45 * SECOND)).toBe("45s");
  });

  test("renders multi-minute durations as Xm Ys", () => {
    expect(formatDuration(MINUTE)).toBe("1m 0s");
    expect(formatDuration(2 * MINUTE + 30 * SECOND)).toBe("2m 30s");
  });

  test("null + terminal status renders an em-dash", () => {
    expect(formatDuration(null, "completed")).toBe("—");
    expect(formatDuration(null, "failed")).toBe("—");
    expect(formatDuration(null, "cancelled")).toBe("—");
  });

  test("null + non-terminal status renders 'in progress'", () => {
    expect(formatDuration(null, "queued")).toBe("in progress");
    expect(formatDuration(null, "running")).toBe("in progress");
    expect(formatDuration(null)).toBe("in progress");
  });
});

describe("formatRelative", () => {
  const NOW = 1_700_000_000_000;
  function ago(ms: number): string {
    const iso = new Date(NOW - ms).toISOString();
    return formatRelative(iso, NOW);
  }

  test("under 5s renders 'just now'", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(2 * SECOND)).toBe("just now");
  });

  test("seconds", () => {
    expect(ago(10 * SECOND)).toBe("10s ago");
    expect(ago(59 * SECOND)).toBe("59s ago");
  });

  test("minutes", () => {
    expect(ago(MINUTE)).toBe("1m ago");
    expect(ago(45 * MINUTE)).toBe("45m ago");
  });

  test("hours", () => {
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(23 * HOUR)).toBe("23h ago");
  });

  test("days", () => {
    expect(ago(DAY)).toBe("1d ago");
    expect(ago(7 * DAY)).toBe("7d ago");
  });
});
