import type { PrismaClient } from "@prisma/client";
import { config } from "../config.ts";
import { log } from "../logger.ts";

export class Pruner {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private prisma: PrismaClient) {}

  start() {
    if (this.timer) return;
    // Run once immediately, then on interval
    this.prune();
    this.timer = setInterval(() => this.prune(), config.prune.intervalMs);
    log.info(
      `[pruner] started (interval=${config.prune.intervalMs}ms retention=${config.prune.retentionDays}d)`,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("[pruner] stopped");
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
