/**
 * Component test for JobsPage. The behavior under test:
 *   - On mount, fetchJobs is called once (initial load).
 *   - On the FIRST WebSocket "connected" message, no extra fetch happens.
 *   - On every subsequent reconnect (close → backoff → open → "connected"),
 *     fetchJobs is called again so the table resyncs after dropped updates.
 *
 * This guards the user-visible bug where the dashboard would silently go stale
 * after any disconnect (laptop sleep, server restart, idle WS close, network
 * blip) until the user manually reloaded the page.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import JobsPage from "./JobsPage.svelte";

// ── Fake WebSocket ──────────────────────────────────────────────────────────
// Captures every constructor call and exposes fire() for tests to drive
// open/message/close events deterministically.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static last(): FakeWebSocket {
    const inst = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!inst) throw new Error("no WebSocket instances yet");
    return inst;
  }

  url: string;
  readyState = 0;
  private listeners: Record<string, Array<(e: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  close() {
    this.fire("close", {});
  }

  send(_data: unknown) {}

  fire(type: string, event: any) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

describe("JobsPage WebSocket reconnect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;

    fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/dashboard/jobs")) {
        return {
          ok: true,
          json: async () => ({ jobs: [], total: 0, limit: 50, offset: 0 }),
        } as any;
      }
      throw new Error(`unexpected fetch url: ${String(url)}`);
    });
    (globalThis as any).fetch = fetchMock;

    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("refetches on each WS reconnect but not on the first connect", async () => {
    render(JobsPage);

    // Drain microtasks so onMount → load() → fetch can run.
    await vi.advanceTimersByTimeAsync(0);

    // 1: initial mount load.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);

    // First connect: open + server "connected" message. Should NOT trigger a
    // second load (firstConnect path).
    FakeWebSocket.last().fire("open", {});
    FakeWebSocket.last().fire("message", {
      data: JSON.stringify({ type: "connected" }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ── First disconnect/reconnect cycle ──────────────────────────────────
    FakeWebSocket.last().fire("close", {});
    // api.ts schedules connect() via setTimeout(reconnectDelay = 1000).
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.last().fire("open", {});
    FakeWebSocket.last().fire("message", {
      data: JSON.stringify({ type: "connected" }),
    });
    await vi.advanceTimersByTimeAsync(0);

    // 2: resync on reconnect.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ── Second disconnect/reconnect — backoff doubles to 2000ms ──────────
    FakeWebSocket.last().fire("close", {});
    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeWebSocket.instances.length).toBe(3);
    FakeWebSocket.last().fire("open", {});
    FakeWebSocket.last().fire("message", {
      data: JSON.stringify({ type: "connected" }),
    });
    await vi.advanceTimersByTimeAsync(0);

    // 3: resync on every subsequent reconnect.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
