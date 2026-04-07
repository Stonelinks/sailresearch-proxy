import { describe, test, expect } from "bun:test";
import { getBackoffMs } from "../services/poller.ts";

describe("getBackoffMs", () => {
  test("returns 2s for polls 0-2", () => {
    expect(getBackoffMs(0)).toBe(2000);
    expect(getBackoffMs(1)).toBe(2000);
    expect(getBackoffMs(2)).toBe(2000);
  });

  test("returns 5s for polls 3-5", () => {
    expect(getBackoffMs(3)).toBe(5000);
    expect(getBackoffMs(4)).toBe(5000);
    expect(getBackoffMs(5)).toBe(5000);
  });

  test("returns 10s for polls 6-20", () => {
    expect(getBackoffMs(6)).toBe(10000);
    expect(getBackoffMs(10)).toBe(10000);
    expect(getBackoffMs(20)).toBe(10000);
  });

  test("returns 30s for polls 21+", () => {
    expect(getBackoffMs(21)).toBe(30000);
    expect(getBackoffMs(100)).toBe(30000);
  });
});
