import type { PrismaClient } from "@prisma/client";
import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../../shared/logger.ts";
import { broadcastJobUpdate } from "../routes/dashboard-api.ts";
import { RecurringTask } from "./recurring-task.ts";
import { JOB_SUMMARY_SELECT, jobToSummary } from "./job-shapes.ts";
import { now } from "../../shared/time.ts";
import type { JobWaiter, CompletionWindow } from "../types.ts";

export function getBackoffMs(pollCount: number): number {
  if (pollCount < 3) return 2000;
  if (pollCount < 6) return 5000;
  if (pollCount < 21) return 10000;
  return 30000;
}

export interface WaiterRegistration {
  /** Resolves with the Sail job result, rejects on failure / cancellation. */
  promise: Promise<any>;
  /**
   * Remove this specific waiter from the poller. Safe to call multiple
   * times; safe to call after the waiter has already resolved/rejected.
   * Other waiters on the same `sailResponseId` are unaffected.
   */
  cancel: () => void;
}

export class Poller {
  private task: RecurringTask | null = null;
  // Multiple waiters per sailResponseId — concurrent dedup-hit requests
  // both register here, both must be resolved/rejected when the job settles.
  // Using a Set so cancel() can remove a specific waiter by reference.
  private waiters = new Map<string, Set<JobWaiter>>();
  private inFlight = new Set<string>();

  constructor(private prisma: PrismaClient) {}

  start() {
    if (this.task?.running) return;
    this.task = new RecurringTask(
      "poller",
      () => this.tick(),
      config.polling.intervalMs,
    );
    this.task.start();
  }

  stop() {
    this.task?.stop();
    // Reject every waiter across every job.
    for (const set of this.waiters.values()) {
      for (const waiter of set) {
        waiter.reject(new Error("Poller stopped"));
      }
    }
    this.waiters.clear();
  }

  registerWaiter(sailResponseId: string): WaiterRegistration {
    let cancel!: () => void;
    const promise = new Promise<any>((resolve, reject) => {
      const waiter: JobWaiter = { resolve, reject, createdAt: now() };
      let set = this.waiters.get(sailResponseId);
      if (!set) {
        set = new Set();
        this.waiters.set(sailResponseId, set);
      }
      set.add(waiter);
      cancel = () => {
        const s = this.waiters.get(sailResponseId);
        if (!s) return;
        s.delete(waiter);
        if (s.size === 0) this.waiters.delete(sailResponseId);
      };
    });
    return { promise, cancel };
  }

  /**
   * Resolve every waiter registered for this sailResponseId with `data`,
   * then drop the entry. Safe to call when no waiters are registered.
   */
  private resolveWaiters(sailResponseId: string, data: any) {
    const set = this.waiters.get(sailResponseId);
    if (!set) return;
    this.waiters.delete(sailResponseId);
    for (const waiter of set) waiter.resolve(data);
  }

  /** Reject every waiter registered for this sailResponseId. */
  private rejectWaiters(sailResponseId: string, error: any) {
    const set = this.waiters.get(sailResponseId);
    if (!set) return;
    this.waiters.delete(sailResponseId);
    for (const waiter of set) waiter.reject(error);
  }

  private async tick() {
    if (this.inFlight.size >= config.polling.maxConcurrent) return;

    const now = new Date();

    // Expire jobs that have exceeded their window-specific timeout
    const activeJobs = await this.prisma.pendingJob.findMany({
      where: {
        status: { notIn: ["completed", "failed", "cancelled"] },
      },
      select: {
        id: true,
        sailResponseId: true,
        completionWindow: true,
        createdAt: true,
      },
    });

    for (const job of activeJobs) {
      const window = job.completionWindow as CompletionWindow;
      // asap jobs never go through the poller — if one is here it's a bug.
      // Expire it on first sight so the row doesn't sit forever.
      if (window === "asap") {
        log.warn(
          `[poller] unexpected asap job in poll queue id=${job.sailResponseId}; expiring`,
        );
        await this.prisma.pendingJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorBody: JSON.stringify({
              error: { message: "asap job in poll queue" },
            }),
          },
        });
        this.broadcastUpdate(job.id);
        this.rejectWaiters(job.sailResponseId, {
          error: { message: "asap job in poll queue" },
        });
        continue;
      }
      const timeoutMs = getTimeoutMs(window);
      const deadline = new Date(job.createdAt.getTime() + timeoutMs);
      if (now >= deadline) {
        log.warn(
          `[poller] expiring timed-out job id=${job.sailResponseId} window=${job.completionWindow} timeoutMs=${timeoutMs}`,
        );
        await this.prisma.pendingJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorBody: JSON.stringify({
              error: {
                message: `Job timed out after ${timeoutMs}ms (window: ${job.completionWindow})`,
              },
            }),
          },
        });
        this.broadcastUpdate(job.id);
        this.rejectWaiters(job.sailResponseId, {
          error: {
            message: `Job timed out after ${timeoutMs}ms (window: ${job.completionWindow})`,
          },
        });
      }
    }

    // Poll jobs that are due. Over-fetch slightly so that jobs already
    // in-flight (and skipped below) don't reduce the per-tick batch size.
    const slotsAvailable = config.polling.maxConcurrent - this.inFlight.size;
    const jobs = await this.prisma.pendingJob.findMany({
      where: {
        status: { notIn: ["completed", "failed", "cancelled"] },
        nextPollAt: { lte: now },
      },
      take: slotsAvailable + this.inFlight.size,
    });

    let started = 0;
    for (const job of jobs) {
      if (started >= slotsAvailable) break;
      if (this.inFlight.has(job.id)) continue;
      this.pollJob(job);
      started++;
    }

    if (jobs.length > 0) {
      log.debug(
        `[poller] tick inFlight=${this.inFlight.size} jobsFound=${jobs.length} started=${started}`,
      );
    }
  }

  private async pollJob(job: any) {
    this.inFlight.add(job.id);
    try {
      log.debug(
        `[poller] polling id=${job.sailResponseId} pollCount=${job.pollCount}`,
      );
      const { status, data } = await sail.getResponse(job.sailResponseId);

      log.debug(
        `[poller] sail status=${status} sailStatus=${data?.status} id=${job.sailResponseId}`,
      );

      if (status !== 200) {
        log.error(
          `[poller] error polling ${job.sailResponseId}: HTTP ${status}`,
        );
        await this.scheduleRetry(job);
        return;
      }

      const sailStatus = data.status;

      if (sailStatus === "completed") {
        const responseBody = JSON.stringify(data);
        await this.prisma.pendingJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            responseBody,
            completedAt: new Date(),
          },
        });

        this.broadcastUpdate(job.id);
        this.resolveWaiters(job.sailResponseId, data);
        log.info(`[poller] completed ${job.sailResponseId}`);
      } else if (sailStatus === "failed" || sailStatus === "cancelled") {
        const errorBody = JSON.stringify(data);
        await this.prisma.pendingJob.update({
          where: { id: job.id },
          data: { status: sailStatus, errorBody },
        });

        this.broadcastUpdate(job.id);
        this.rejectWaiters(job.sailResponseId, data);
        log.info(`[poller] ${sailStatus} ${job.sailResponseId}`);
      } else {
        // Still pending or running
        await this.scheduleRetry(job, sailStatus);
        this.broadcastUpdate(job.id);
      }
    } catch (err) {
      log.error(`[poller] fetch error for ${job.sailResponseId}:`, err);
      await this.scheduleRetry(job);
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async broadcastUpdate(jobId: string) {
    try {
      const job = await this.prisma.pendingJob.findUnique({
        where: { id: jobId },
        select: JOB_SUMMARY_SELECT,
      });
      if (!job) return;
      broadcastJobUpdate(jobToSummary(job));
    } catch {
      // Non-critical: don't let broadcast failures affect polling
    }
  }

  private async scheduleRetry(job: any, newStatus?: string) {
    const newPollCount = job.pollCount + 1;
    const backoff = getBackoffMs(newPollCount);
    log.debug(
      `[poller] retry id=${job.sailResponseId} newPollCount=${newPollCount} backoffMs=${backoff} newStatus=${newStatus ?? job.status}`,
    );
    await this.prisma.pendingJob.update({
      where: { id: job.id },
      data: {
        status: newStatus ?? job.status,
        pollCount: newPollCount,
        nextPollAt: new Date(now() + backoff),
      },
    });
  }
}
