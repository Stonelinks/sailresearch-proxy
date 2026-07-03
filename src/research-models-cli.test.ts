import { describe, test, expect } from "bun:test";
import { parseArgs } from "./research-models-cli.ts";

describe("parseArgs", () => {
  test("defaults: no model IDs, local base URL", () => {
    const opts = parseArgs([]);
    expect(opts.modelIds).toEqual([]);
    expect(opts.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  test("positional args become model IDs", () => {
    const opts = parseArgs(["org/model-a", "org/model-b"]);
    expect(opts.modelIds).toEqual(["org/model-a", "org/model-b"]);
  });

  test("--base-url overrides the default", () => {
    const opts = parseArgs(["--base-url", "http://example.com:4100/v1"]);
    expect(opts.baseUrl).toBe("http://example.com:4100/v1");
    expect(opts.modelIds).toEqual([]);
  });

  test("mixes positional IDs and options", () => {
    const opts = parseArgs([
      "org/model-a",
      "--base-url",
      "http://example.com/v1",
      "org/model-b",
    ]);
    expect(opts.modelIds).toEqual(["org/model-a", "org/model-b"]);
    expect(opts.baseUrl).toBe("http://example.com/v1");
  });
});
