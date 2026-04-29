import type { PrismaClient } from "@prisma/client";
import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../logger.ts";
import type { JobWaiter, CompletionWindow } from "../types.ts";

export function getBackoffMs(pollCount: number): number {
  if (pollCount < 3) return 2000;
  if (pollCount < 6) return 5000;
  if (pollCount < 21) return 10000;
  return 30000;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Map<string, JobWaiter>();
  private activePollCount = 0;

  constructor(private prisma: PrismaClient) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), config.polling.intervalMs);
    log.info("[poller] started");
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Reject all waiters
    for (const [id, waiter] of this.waiters) {
      waiter.reject(new Error("Poller stopped"));
    }
    this.waiters.clear();
    log.info("[poller] stopped");
  }

  registerWaiter(sailResponseId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.waiters.set(sailResponseId, {
        resolve,
        reject,
        createdAt: Date.now(),
      });
    });
  }

  unregisterWaiter(sailResponseId: string) {
    this.waiters.delete(sailResponseId);
  }

  private async tick() {
    if (this.activePollCount >= config.polling.maxConcurrent) return;

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
      const timeoutMs = getTimeoutMs(job.completionWindow as CompletionWindow);
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
        const waiter = this.waiters.get(job.sailResponseId);
        if (waiter) {
          waiter.reject({
            error: {
              message: `Job timed out after ${timeoutMs}ms (window: ${job.completionWindow})`,
            },
          });
          this.waiters.delete(job.sailResponseId);
        }
      }
    }

    // Poll jobs that are due
    const jobs = await this.prisma.pendingJob.findMany({
      where: {
        status: { notIn: ["completed", "failed", "cancelled"] },
        nextPollAt: { lte: now },
      },
      take: config.polling.maxConcurrent - this.activePollCount,
    });

    if (jobs.length > 0) {
      log.debug(
        `[poller] tick activePolls=${this.activePollCount} jobsFound=${jobs.length}`,
      );
    }

    for (const job of jobs) {
      this.pollJob(job);
    }
  }

  private async pollJob(job: any) {
    this.activePollCount++;
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

        const waiter = this.waiters.get(job.sailResponseId);
        if (waiter) {
          waiter.resolve(data);
          this.waiters.delete(job.sailResponseId);
        }
        log.info(`[poller] completed ${job.sailResponseId}`);
      } else if (sailStatus === "failed" || sailStatus === "cancelled") {
        const errorBody = JSON.stringify(data);
        await this.prisma.pendingJob.update({
          where: { id: job.id },
          data: { status: sailStatus, errorBody },
        });

        const waiter = this.waiters.get(job.sailResponseId);
        if (waiter) {
          waiter.reject(data);
          this.waiters.delete(job.sailResponseId);
        }
        log.info(`[poller] ${sailStatus} ${job.sailResponseId}`);
      } else {
        // Still pending or running
        await this.scheduleRetry(job, sailStatus);
      }
    } catch (err) {
      log.error(`[poller] fetch error for ${job.sailResponseId}:`, err);
      await this.scheduleRetry(job);
    } finally {
      this.activePollCount--;
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
        nextPollAt: new Date(Date.now() + backoff),
      },
    });
  }
}
