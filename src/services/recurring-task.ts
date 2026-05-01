import { log } from "../logger.ts";

export class RecurringTask {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _running = false;

  constructor(
    private name: string,
    private fn: () => Promise<void>,
    private intervalMs: number,
    private options: { runImmediately?: boolean } = {},
  ) {}

  get running(): boolean {
    return this._running;
  }

  start() {
    if (this.timeout) return;
    this.stopped = false;
    this._running = true;

    if (this.options.runImmediately) {
      this.executeAndSchedule();
    } else {
      this.scheduleNext();
    }

    log.info(`[${this.name}] started (interval=${this.intervalMs}ms)`);
  }

  stop() {
    this.stopped = true;
    this._running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    log.info(`[${this.name}] stopped`);
  }

  private scheduleNext() {
    if (this.stopped) return;
    this.timeout = setTimeout(() => {
      this.executeAndSchedule();
    }, this.intervalMs);
  }

  private async executeAndSchedule() {
    if (this.stopped) return;

    try {
      await this.fn();
    } catch (err) {
      log.error(`[${this.name}] error:`, err);
    }

    this.scheduleNext();
  }
}
