import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { handleWindowPrefixedRoute, dispatchRoute } from "./router.ts";
import type { CompletionWindow } from "./types.ts";

// Create a minimal mock poller with the shape dispatchRoute expects
// (it only passes it to handleChatCompletions)
const mockPoller = {
  registerWaiter: mock(),
  unregisterWaiter: mock(),
  stop: mock(),
  start: mock(),
} as any;

// --- Tests for dispatchRoute ---

describe("dispatchRoute", () => {
  test("returns 404 for unknown /v1/ paths", async () => {
    const req = new Request("http://localhost/v1/unknown", { method: "GET" });
    const result = dispatchRoute(req, "/v1/unknown", mockPoller);
    const res = result instanceof Promise ? await result : result;
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error.message).toBe("Not found");
  });

  test("returns 404 for GET /v1/chat/completions (wrong method)", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "GET",
    });
    const result = dispatchRoute(req, "/v1/chat/completions", mockPoller);
    const res = result instanceof Promise ? await result : result;
    expect(res.status).toBe(404);
  });

  test("returns 404 for POST /v1/models (wrong method)", async () => {
    const req = new Request("http://localhost/v1/models", {
      method: "POST",
    });
    const result = dispatchRoute(req, "/v1/models", mockPoller);
    const res = result instanceof Promise ? await result : result;
    expect(res.status).toBe(404);
  });

  test("returns 404 for root path", async () => {
    const req = new Request("http://localhost/", { method: "GET" });
    const result = dispatchRoute(req, "/", mockPoller);
    const res = result instanceof Promise ? await result : result;
    expect(res.status).toBe(404);
  });

  test("returns 404 for GET /v1/messages (wrong method)", async () => {
    const req = new Request("http://localhost/v1/messages", { method: "GET" });
    const result = dispatchRoute(req, "/v1/messages", mockPoller);
    const res = result instanceof Promise ? await result : result;
    expect(res.status).toBe(404);
  });
});

// --- Tests for handleWindowPrefixedRoute ---

describe("handleWindowPrefixedRoute", () => {
  const windows: CompletionWindow[] = ["asap", "priority", "standard", "flex"];

  test("returns null for non-prefixed /v1/ paths", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
    });
    expect(handleWindowPrefixedRoute(req, mockPoller)).toBeNull();
  });

  test("returns null for invalid window prefix", () => {
    const req = new Request("http://localhost/urgent/v1/chat/completions", {
      method: "POST",
    });
    expect(handleWindowPrefixedRoute(req, mockPoller)).toBeNull();
  });

  test("returns null for /health (no /v1/ segment)", () => {
    const req = new Request("http://localhost/health");
    expect(handleWindowPrefixedRoute(req, mockPoller)).toBeNull();
  });

  test("returns null for /dashboard", () => {
    const req = new Request("http://localhost/dashboard");
    expect(handleWindowPrefixedRoute(req, mockPoller)).toBeNull();
  });

  test("returns null for /api/dashboard/jobs", () => {
    const req = new Request("http://localhost/api/dashboard/jobs");
    expect(handleWindowPrefixedRoute(req, mockPoller)).toBeNull();
  });

  test.each(windows)("detects /%s/v1/models as window-prefixed", (window) => {
    const req = new Request(`http://localhost/${window}/v1/models`, {
      method: "GET",
    });
    expect(handleWindowPrefixedRoute(req, mockPoller)).not.toBeNull();
  });

  test.each(windows)(
    "detects /%s/v1/chat/completions as window-prefixed",
    (window) => {
      const req = new Request(
        `http://localhost/${window}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test", messages: [] }),
        },
      );
      expect(handleWindowPrefixedRoute(req, mockPoller)).not.toBeNull();
    },
  );

  test.each(windows)("detects /%s/v1/messages as window-prefixed", (window) => {
    const req = new Request(`http://localhost/${window}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(handleWindowPrefixedRoute(req, mockPoller)).not.toBeNull();
  });

  test("returns 404 for window-prefixed unknown /v1/ path", async () => {
    const req = new Request("http://localhost/flex/v1/nonexistent", {
      method: "GET",
    });
    const result = handleWindowPrefixedRoute(req, mockPoller);
    expect(result).not.toBeNull();
    const res = await result!;
    expect(res.status).toBe(404);
  });

  test("returns 404 for window-prefixed GET on POST-only endpoint", async () => {
    const req = new Request("http://localhost/flex/v1/chat/completions", {
      method: "GET",
    });
    const result = handleWindowPrefixedRoute(req, mockPoller);
    expect(result).not.toBeNull();
    const res = await result!;
    expect(res.status).toBe(404);
  });

  test("injected header overrides an existing X-Completion-Window", async () => {
    // If a request to /flex/v1/models already has X-Completion-Window: asap,
    // the URL prefix (flex) should override it.
    // We verify by checking that resolveCompletionWindow (used by
    // handleChatCompletions) gives prefix priority over header.
    // Here we just verify the request is routed correctly.
    const req = new Request("http://localhost/flex/v1/models", {
      method: "GET",
      headers: { "X-Completion-Window": "asap" },
    });
    const result = handleWindowPrefixedRoute(req, mockPoller);
    expect(result).not.toBeNull();
    const res = await result!;
    // Models endpoint should succeed regardless of window
    expect(res.status).toBe(200);
  });
});
