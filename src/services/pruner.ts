import type { PrismaClient } from "@prisma/client";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { RecurringTask } from "./recurring-task.ts";

export class Pruner {
  private task: RecurringTask | null = null;

  constructor(private prisma: PrismaClient) {}

  start() {
    if (this.task?.running) return;
    this.task = new RecurringTask(
      "pruner",
      () => this.prune(),
      config.prune.intervalMs,
      { runImmediately: true },
    );
    this.task.start();
    log.info(`[pruner] retention=${config.prune.retentionDays}d`);
  }

  stop() {
    this.task?.stop();
  }

  async prune() {
    const cutoff = new Date(
      Date.now() - config.prune.retentionDays * 24 * 60 * 60 * 1000,
    );

    try {
      const result = await this.prisma.pendingJob.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        log.info(
          `[pruner] deleted ${result.count} job(s) older than ${config.prune.retentionDays} days`,
        );
      } else {
        log.debug("[pruner] no jobs to prune");
      }
    } catch (err) {
      log.error("[pruner] error during prune:", err);
    }
  }
}
