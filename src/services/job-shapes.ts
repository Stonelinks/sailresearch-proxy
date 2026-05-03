/**
 * Wire shapes for jobs returned to the dashboard SPA. Centralised here so
 * that the REST list, REST detail, and WebSocket broadcast paths can't
 * drift independently — three call sites previously each declared their own
 * Prisma `select` and inline mapping.
 */
import type { JobStatus } from "../types.ts";

export const JOB_SUMMARY_SELECT = {
  id: true,
  sailResponseId: true,
  status: true,
  model: true,
  completionWindow: true,
  apiType: true,
  createdAt: true,
  completedAt: true,
  pollCount: true,
  errorBody: true,
} as const;

export const JOB_DETAIL_SELECT = {
  ...JOB_SUMMARY_SELECT,
  requestBody: true,
  responseBody: true,
} as const;

/** A job row with the JOB_SUMMARY_SELECT shape. */
export interface JobSummaryRow {
  id: string;
  sailResponseId: string;
  status: string;
  model: string;
  completionWindow: string;
  apiType: string;
  createdAt: Date;
  completedAt: Date | null;
  pollCount: number;
  errorBody: string | null;
}

export interface JobDetailRow extends JobSummaryRow {
  requestBody: string | null;
  responseBody: string | null;
}

export interface JobSummary {
  id: string;
  sailResponseId: string;
  status: JobStatus;
  model: string;
  completionWindow: string;
  apiType: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  pollCount: number;
  hasError: boolean;
}

export interface JobDetail extends JobSummary {
  requestBody: string | null;
  responseBody: string | null;
  errorBody: string | null;
}

export function jobToSummary(job: JobSummaryRow): JobSummary {
  return {
    id: job.id,
    sailResponseId: job.sailResponseId,
    status: job.status as JobStatus,
    model: job.model,
    completionWindow: job.completionWindow,
    apiType: job.apiType,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs: job.completedAt
      ? job.completedAt.getTime() - job.createdAt.getTime()
      : null,
    pollCount: job.pollCount,
    hasError: job.errorBody !== null,
  };
}

export function jobToDetail(job: JobDetailRow): JobDetail {
  return {
    ...jobToSummary(job),
    requestBody: job.requestBody,
    responseBody: job.responseBody,
    errorBody: job.errorBody,
  };
}
