import { describe, test, expect } from "bun:test";
import { mapSailStatus } from "./types.ts";
import type { JobStatus } from "./types.ts";

describe("mapSailStatus", () => {
  test("maps in_progress to running", () => {
    expect(mapSailStatus("in_progress")).toBe("running");
  });

  test("passes through native JobStatus values unchanged", () => {
    const native: JobStatus[] = [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const s of native) {
      expect(mapSailStatus(s)).toBe(s);
    }
  });
});
