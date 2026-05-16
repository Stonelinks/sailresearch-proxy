import { describe, test, expect } from "bun:test";
import {
  handlePassthrough,
  handlePassthroughResponses,
} from "./passthrough.ts";
import { swapConfig } from "../test-helpers.ts";

describe("passthrough error handling", () => {
  test("handlePassthrough returns 502 when Sail fetch throws", async () => {
    // Point to a dead port — fetch will throw immediately
    const deadServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = deadServer.port;
    deadServer.stop(true);

    const restore = swapConfig({
      sail: {
        baseUrl: `http://localhost:${deadPort}/v1`,
        apiKey: "test",
        inferenceTimeoutMs: 200,
      },
    });

    const response = await handlePassthrough(
      {
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
      "asap",
      false,
    );

    expect(response.status).toBe(502);
    const body: any = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("Sail request failed");

    restore();
  });

  test("handlePassthroughResponses returns 502 when Sail fetch throws", async () => {
    const deadServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = deadServer.port;
    deadServer.stop(true);

    const restore = swapConfig({
      sail: {
        baseUrl: `http://localhost:${deadPort}/v1`,
        apiKey: "test",
        inferenceTimeoutMs: 200,
      },
    });

    const response = await handlePassthroughResponses(
      { model: "test", input: "hi" },
      "asap",
    );

    expect(response.status).toBe(502);
    const body: any = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("Sail request failed");

    restore();
  });
});
