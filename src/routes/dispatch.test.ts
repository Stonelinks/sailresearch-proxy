import { describe, test, expect } from "bun:test";
import { rewriteForWindowPrefix } from "./dispatch.ts";
import type { CompletionWindow } from "../types.ts";

const windows: CompletionWindow[] = ["asap", "priority", "standard", "flex"];

describe("rewriteForWindowPrefix", () => {
  test("returns null for non-prefixed /v1/ paths", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
    });
    expect(rewriteForWindowPrefix(req)).toBeNull();
  });

  test("returns null for invalid window prefix", () => {
    const req = new Request("http://localhost/urgent/v1/chat/completions", {
      method: "POST",
    });
    expect(rewriteForWindowPrefix(req)).toBeNull();
  });

  test("returns null for /health (no /v1/ segment)", () => {
    const req = new Request("http://localhost/health");
    expect(rewriteForWindowPrefix(req)).toBeNull();
  });

  test("returns null for /api/dashboard/jobs", () => {
    const req = new Request("http://localhost/api/dashboard/jobs");
    expect(rewriteForWindowPrefix(req)).toBeNull();
  });

  test.each(windows)(
    "rewrites /%s/v1/chat/completions to /v1/chat/completions",
    (window) => {
      const req = new Request(
        `http://localhost/${window}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test", messages: [] }),
        },
      );
      const result = rewriteForWindowPrefix(req);
      expect(result).not.toBeNull();
      expect(result!.prefix).toBe(window);
      expect(result!.pathname).toBe("/v1/chat/completions");
      expect(result!.req.headers.get("x-completion-window")).toBe(window);
    },
  );

  test.each(windows)("rewrites /%s/v1/messages preserving body", (window) => {
    const req = new Request(`http://localhost/${window}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    const result = rewriteForWindowPrefix(req);
    expect(result).not.toBeNull();
    expect(result!.pathname).toBe("/v1/messages");
  });

  test.each(windows)("rewrites GET /%s/v1/models", (window) => {
    const req = new Request(`http://localhost/${window}/v1/models`, {
      method: "GET",
    });
    const result = rewriteForWindowPrefix(req);
    expect(result).not.toBeNull();
    expect(result!.pathname).toBe("/v1/models");
    expect(result!.req.method).toBe("GET");
  });

  test("injected x-completion-window overrides any existing value", () => {
    const req = new Request("http://localhost/flex/v1/models", {
      method: "GET",
      headers: { "X-Completion-Window": "asap" },
    });
    const result = rewriteForWindowPrefix(req);
    expect(result!.req.headers.get("x-completion-window")).toBe("flex");
  });
});
