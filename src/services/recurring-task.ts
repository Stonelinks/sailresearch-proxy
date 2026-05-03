import { log } from "../../shared/logger.ts";

/**
 * Schedules `fn` on a chained-setTimeout loop: each fire awaits the previous
 * completion, then waits `intervalMs` before the next. Errors thrown by `fn`
 * are logged but do not break the loop. Single source of truth for "is the
 * task active" via `running`.
 *
 * Callers that want a one-shot run on startup should invoke their workload
 * once before calling `start()` — keeps this class flag-free.
 */
export class RecurringTask {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  constructor(
    private name: string,
    private fn: () => Promise<void>,
    private intervalMs: number,
  ) {}

  get running(): boolean {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.scheduleNext();
    log.info(`[${this.name}] started (interval=${this.intervalMs}ms)`);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    log.info(`[${this.name}] stopped`);
  }

  private scheduleNext() {
    if (!this._running) return;
    this.timeout = setTimeout(async () => {
      this.timeout = null;
      try {
        await this.fn();
      } catch (err) {
        log.error(`[${this.name}] error:`, err);
      }
      this.scheduleNext();
    }, this.intervalMs);
  }
}
