import { describe, test, expect } from "bun:test";
import { jobToSummary, jobToDetail } from "./job-shapes.ts";
import type { JobSummaryRow, JobDetailRow } from "./job-shapes.ts";

const baseRow = (): JobSummaryRow => ({
  id: "job1",
  sailResponseId: "resp1",
  status: "queued",
  model: "test-model",
  completionWindow: "flex",
  apiType: "chat-completions",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  completedAt: null,
  pollCount: 3n,
  errorBody: null,
});

describe("jobToSummary", () => {
  test("maps in_progress status to running", () => {
    const row = { ...baseRow(), status: "in_progress" };
    const summary = jobToSummary(row);
    expect(summary.status).toBe("running");
  });

  test("passes through native JobStatus values unchanged", () => {
    for (const status of [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      const row = { ...baseRow(), status };
      expect(jobToSummary(row).status).toBe(status);
    }
  });

  test("computes durationMs when completedAt is set", () => {
    const row = {
      ...baseRow(),
      status: "completed",
      completedAt: new Date("2025-01-01T00:01:00Z"),
    };
    const summary = jobToSummary(row);
    expect(summary.durationMs).toBe(60_000);
    expect(summary.hasError).toBe(false);
  });

  test("sets hasError true when errorBody is present", () => {
    const row = { ...baseRow(), errorBody: '{"error":{"message":"oom"}}' };
    expect(jobToSummary(row).hasError).toBe(true);
  });
});

describe("jobToDetail", () => {
  test("includes requestBody, responseBody, and errorBody", () => {
    const row: JobDetailRow = {
      ...baseRow(),
      status: "completed",
      completedAt: new Date("2025-01-01T00:00:30Z"),
      requestBody: '{"model":"m"}',
      responseBody: '{"output":[]}',
      errorBody: null,
    };
    const detail = jobToDetail(row);
    expect(detail.status).toBe("completed");
    expect(detail.requestBody).toBe('{"model":"m"}');
    expect(detail.responseBody).toBe('{"output":[]}');
    expect(detail.errorBody).toBeNull();
  });

  test("maps in_progress status to running", () => {
    const row: JobDetailRow = {
      ...baseRow(),
      status: "in_progress",
      requestBody: null,
      responseBody: null,
      errorBody: null,
    };
    expect(jobToDetail(row).status).toBe("running");
  });
});
