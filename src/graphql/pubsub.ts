/**
 * In-process pub/sub for GraphQL subscriptions. Single-process app, so a
 * plain EventTarget + async iterator wrapper is enough — no Redis or
 * external broker. Each `subscribe(event)` returns an `AsyncIterableIterator`
 * that yields published payloads and exits cleanly when the client
 * disconnects (the iterator's `return()` gets called by graphql-js).
 */
export type Events = {
  modelResearchUpdated: import("./research-tracker.ts").ModelResearchUpdatePayload;
};

class PubSub {
  private target = new EventTarget();

  publish<K extends keyof Events>(event: K, payload: Events[K]) {
    this.target.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }

  async *subscribe<K extends keyof Events>(
    event: K,
  ): AsyncGenerator<Events[K], void, void> {
    const queue: Events[K][] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;

    const handler = (ev: Event) => {
      const payload = (ev as CustomEvent<Events[K]>).detail;
      queue.push(payload);
      resolveNext?.();
      resolveNext = null;
    };

    this.target.addEventListener(event, handler);

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      done = true;
      this.target.removeEventListener(event, handler);
    }
  }
}

export const pubsub = new PubSub();
