import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseRequest, wrapRouteLogging } from "./parse-request.ts";
import { config } from "../config.ts";

function makeRequest(body: any, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/anything", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parseRequest", () => {
  let originalProxyKey: string | undefined;

  beforeEach(() => {
    originalProxyKey = config.proxyApiKey;
  });
  afterEach(() => {
    config.proxyApiKey = originalProxyKey;
  });

  test("returns parsed body and resolved window on success", async () => {
    config.proxyApiKey = undefined;
    const req = makeRequest({ model: "m" });
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: "priority",
    });
    expect("ok" in result).toBe(true);
    if (!("ok" in result)) return;
    expect(result.ok.body.model).toBe("m");
    expect(result.ok.completionWindow).toBe("priority");
  });

  test("rejects when authorization is missing and proxyApiKey is set", async () => {
    config.proxyApiKey = "secret";
    const req = makeRequest({ model: "m" });
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: null,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.status).toBe(401);
  });

  test("accepts Authorization: Bearer ...", async () => {
    config.proxyApiKey = "secret";
    const req = makeRequest({ model: "m" }, { Authorization: "Bearer secret" });
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: null,
    });
    expect("ok" in result).toBe(true);
  });

  test("accepts x-api-key (Anthropic-style)", async () => {
    config.proxyApiKey = "secret";
    const req = makeRequest({ model: "m" }, { "x-api-key": "secret" });
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: null,
    });
    expect("ok" in result).toBe(true);
  });

  test("returns 400 on malformed JSON", async () => {
    config.proxyApiKey = undefined;
    const req = makeRequest("{not json", {});
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: null,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.status).toBe(400);
  });

  test("returns 400 when model is missing", async () => {
    config.proxyApiKey = undefined;
    const req = makeRequest({});
    const result = await parseRequest(req, {
      routeName: "test",
      urlPrefix: null,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.status).toBe(400);
    const body: any = await result.error.json();
    expect(body.error.message).toMatch(/model is required/);
  });
});

describe("wrapRouteLogging", () => {
  test("forwards request to handler and returns its response", async () => {
    const handler = async () => Response.json({ ok: true });
    const wrapped = wrapRouteLogging("/test", handler);
    const res = await wrapped(makeRequest({ model: "x" }));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
  });
});
