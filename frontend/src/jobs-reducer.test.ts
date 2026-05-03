import { describe, test, expect } from "vitest";
import { applyJobUpdate, type JobsState } from "./jobs-reducer";
import type { Job } from "./api";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "j1",
    sailResponseId: "sr1",
    status: "pending",
    model: "test-model",
    completionWindow: "flex",
    apiType: "responses",
    createdAt: "2026-05-03T00:00:00.000Z",
    completedAt: null,
    durationMs: null,
    pollCount: 0,
    hasError: false,
    ...overrides,
  };
}

const PAGE_SIZE = 50;
const noFilter = "";

describe("applyJobUpdate", () => {
  test("updates an existing job in place when no filter is active", () => {
    const state: JobsState = {
      jobs: [job({ id: "a" }), job({ id: "b" })],
      total: 2,
    };
    const updated = job({ id: "a", status: "completed", pollCount: 7 });

    const res = applyJobUpdate({
      state,
      updatedJob: updated,
      statusFilter: noFilter,
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("updated");
    expect(res.state.jobs[0].status).toBe("completed");
    expect(res.state.jobs[0].pollCount).toBe(7);
    expect(res.state.jobs.length).toBe(2);
    expect(res.state.total).toBe(2);
  });

  test("updates in place when new status still matches active filter", () => {
    const state: JobsState = {
      jobs: [job({ id: "a", status: "pending", pollCount: 3 })],
      total: 1,
    };
    const updated = job({ id: "a", status: "pending", pollCount: 4 });

    const res = applyJobUpdate({
      state,
      updatedJob: updated,
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("updated");
    expect(res.state.jobs[0].pollCount).toBe(4);
  });

  test("removes the row when its new status no longer matches the filter", () => {
    // The bug this guards against: a job that goes pending→completed while the
    // user has the filter set to "pending" should disappear from the table,
    // not stay there showing a green badge.
    const state: JobsState = {
      jobs: [
        job({ id: "a", status: "pending" }),
        job({ id: "b", status: "pending" }),
      ],
      total: 2,
    };
    const updated = job({ id: "a", status: "completed" });

    const res = applyJobUpdate({
      state,
      updatedJob: updated,
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("removed");
    expect(res.state.jobs.length).toBe(1);
    expect(res.state.jobs[0].id).toBe("b");
    expect(res.state.total).toBe(1);
  });

  test("does not let total go below zero on remove", () => {
    const state: JobsState = {
      jobs: [job({ id: "a", status: "pending" })],
      total: 0,
    };
    const updated = job({ id: "a", status: "completed" });

    const res = applyJobUpdate({
      state,
      updatedJob: updated,
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.state.total).toBe(0);
  });

  test("prepends a brand-new job at offset 0 when no filter is active", () => {
    const state: JobsState = { jobs: [job({ id: "a" })], total: 1 };
    const fresh = job({ id: "new", status: "pending" });

    const res = applyJobUpdate({
      state,
      updatedJob: fresh,
      statusFilter: noFilter,
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("prepended");
    expect(res.state.jobs[0].id).toBe("new");
    expect(res.state.jobs.length).toBe(2);
    expect(res.state.total).toBe(2);
  });

  test("prepends only when new job's status matches the active filter", () => {
    const state: JobsState = { jobs: [], total: 0 };

    const matching = applyJobUpdate({
      state,
      updatedJob: job({ id: "x", status: "pending" }),
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });
    expect(matching.action).toBe("prepended");

    const nonMatching = applyJobUpdate({
      state,
      updatedJob: job({ id: "y", status: "completed" }),
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });
    expect(nonMatching.action).toBe("ignored");
    expect(nonMatching.state).toBe(state);
  });

  test("does not prepend when the user is paginated past offset 0", () => {
    const state: JobsState = { jobs: [job({ id: "a" })], total: 51 };

    const res = applyJobUpdate({
      state,
      updatedJob: job({ id: "new" }),
      statusFilter: noFilter,
      offset: 50,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("ignored");
    expect(res.state).toBe(state);
  });

  test("prepending caps the visible list at pageSize", () => {
    const jobs = Array.from({ length: PAGE_SIZE }, (_, i) =>
      job({ id: `j${i}` }),
    );
    const state: JobsState = { jobs, total: PAGE_SIZE };

    const res = applyJobUpdate({
      state,
      updatedJob: job({ id: "new" }),
      statusFilter: noFilter,
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(res.action).toBe("prepended");
    expect(res.state.jobs.length).toBe(PAGE_SIZE);
    expect(res.state.jobs[0].id).toBe("new");
    // The last job in the previous page is pushed off — keeps view tidy.
    expect(res.state.jobs[PAGE_SIZE - 1].id).toBe(`j${PAGE_SIZE - 2}`);
    expect(res.state.total).toBe(PAGE_SIZE + 1);
  });

  test("does not mutate the input state", () => {
    const state: JobsState = {
      jobs: [job({ id: "a", status: "pending" })],
      total: 1,
    };
    const snapshot = JSON.stringify(state);

    applyJobUpdate({
      state,
      updatedJob: job({ id: "a", status: "completed" }),
      statusFilter: noFilter,
      offset: 0,
      pageSize: PAGE_SIZE,
    });
    applyJobUpdate({
      state,
      updatedJob: job({ id: "a", status: "completed" }),
      statusFilter: "pending",
      offset: 0,
      pageSize: PAGE_SIZE,
    });
    applyJobUpdate({
      state,
      updatedJob: job({ id: "fresh" }),
      statusFilter: noFilter,
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
