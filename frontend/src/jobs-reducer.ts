import type { Job } from "./api";

export type JobUpdateAction = "updated" | "removed" | "prepended" | "ignored";

export interface JobsState {
  jobs: Job[];
  total: number;
}

export interface ApplyJobUpdateArgs {
  state: JobsState;
  updatedJob: Job;
  /** "" means no filter; otherwise a JobStatus literal. */
  statusFilter: string;
  /** Current page offset; only offset === 0 may receive prepends. */
  offset: number;
  pageSize: number;
}

/**
 * Pure reducer for live job updates over the WebSocket.
 *
 *   - If the job is already visible, update it in place — unless its new
 *     status no longer matches the active filter, in which case drop it
 *     (otherwise the row would render with a "completed" badge inside a
 *     "pending"-filtered view).
 *   - If the job isn't visible but matches the filter and the user is on
 *     the first page, prepend it and bump `total`.
 *   - Otherwise ignore (e.g., user is paginated past offset 0; the new state
 *     is invisible).
 *
 * Returns a new state object; never mutates the input.
 */
export function applyJobUpdate(args: ApplyJobUpdateArgs): {
  state: JobsState;
  action: JobUpdateAction;
} {
  const { state, updatedJob, statusFilter, offset, pageSize } = args;
  const idx = state.jobs.findIndex((j) => j.id === updatedJob.id);

  if (idx >= 0) {
    if (statusFilter && updatedJob.status !== statusFilter) {
      const jobs = state.jobs.filter((_, i) => i !== idx);
      return {
        state: { jobs, total: Math.max(state.total - 1, 0) },
        action: "removed",
      };
    }
    const jobs = state.jobs.slice();
    jobs[idx] = updatedJob;
    return { state: { jobs, total: state.total }, action: "updated" };
  }

  const matchesFilter = !statusFilter || updatedJob.status === statusFilter;
  if (offset === 0 && matchesFilter) {
    const jobs = [updatedJob, ...state.jobs].slice(0, pageSize);
    return { state: { jobs, total: state.total + 1 }, action: "prepended" };
  }

  return { state, action: "ignored" };
}
