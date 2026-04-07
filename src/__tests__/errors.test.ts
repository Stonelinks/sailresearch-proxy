import { describe, test, expect } from "bun:test";
import { openAIError, mapSailError } from "../errors.ts";

describe("openAIError", () => {
  test("creates error response with correct status", async () => {
    const res = openAIError(400, "Bad request");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toBe("Bad request");
    expect(body.error.type).toBe("server_error");
    expect(body.error.param).toBeNull();
    expect(body.error.code).toBeNull();
  });

  test("supports custom type, param, and code", async () => {
    const res = openAIError(
      422,
      "Invalid param",
      "invalid_request_error",
      "temperature",
      "out_of_range",
    );
    const body: any = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("temperature");
    expect(body.error.code).toBe("out_of_range");
  });
});

describe("mapSailError", () => {
  test("passes through Sail error with error.message", async () => {
    const sailBody = {
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    };
    const res = mapSailError(401, sailBody);
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error.message).toBe("Invalid API key");
  });

  test("maps 5xx Sail errors to 502", async () => {
    const sailBody = {
      error: { message: "Internal error", type: "server_error" },
    };
    const res = mapSailError(500, sailBody);
    expect(res.status).toBe(502);
  });

  test("wraps non-standard Sail error body", async () => {
    const res = mapSailError(400, { message: "something went wrong" });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toBe("something went wrong");
    expect(body.error.type).toBe("upstream_error");
  });

  test("handles empty Sail body", async () => {
    const res = mapSailError(503, {});
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.message).toBe("Sail API error: 503");
  });

  test("handles null Sail body", async () => {
    const res = mapSailError(500, null);
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.message).toBe("Sail API error: 500");
  });
});
