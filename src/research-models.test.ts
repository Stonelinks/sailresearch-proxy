import { describe, test, expect, mock, beforeAll, beforeEach } from "bun:test";
import {
  parseAndValidatePiOutput,
  smokeTestPreset,
  smokeTestPresets,
  chatCompletionsUrlForWindow,
  smokeTestWindowCompatibility,
  pickBestWindow,
  smokeTimeoutForWindow,
} from "./research-models.ts";
import type { CompletionWindow, SamplingPresetInput } from "./types.ts";
import { config } from "./config.ts";

// Set required env vars before any imports that use config
beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

describe("parseAndValidatePiOutput", () => {
  test("parses valid complete output", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({
        contextSize: 131072,
        samplingPresets: [
          {
            name: "default",
            description: "General purpose",
            params: { temperature: 0.7, top_p: 0.95 },
          },
        ],
        description: "A large language model",
        source: "https://huggingface.co/org/model",
      }),
    );

    expect(result.contextSize).toBe(131072);
    expect(result.samplingPresets).toHaveLength(1);
    expect(result.samplingPresets[0]!.name).toBe("default");
    expect(result.samplingPresets[0]!.params.temperature).toBe(0.7);
    expect(result.description).toBe("A large language model");
    expect(result.source).toBe("https://huggingface.co/org/model");
    expect(result.supportsImage).toBe(false);
  });

  test("handles null fields gracefully", () => {
    const result = parseAndValidatePiOutput("{}");

    expect(result.contextSize).toBeNull();
    expect(result.samplingPresets).toEqual([]);
    expect(result.prices).toEqual([]);
    expect(result.description).toBeNull();
    expect(result.source).toBeNull();
    expect(result.supportsImage).toBe(false);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseAndValidatePiOutput("not json")).toThrow(
      "No JSON object found",
    );
  });

  test("rejects non-object JSON", () => {
    expect(() => parseAndValidatePiOutput("[]")).toThrow(
      "No JSON object found",
    );
  });

  test("rejects contextSize with wrong type", () => {
    expect(() =>
      parseAndValidatePiOutput(JSON.stringify({ contextSize: "big" })),
    ).toThrow('"contextSize" must be a number or null');
  });

  test("rejects samplingPresets with wrong type", () => {
    expect(() =>
      parseAndValidatePiOutput(JSON.stringify({ samplingPresets: "oops" })),
    ).toThrow('"samplingPresets" must be an array');
  });

  test("rejects preset with missing name", () => {
    expect(() =>
      parseAndValidatePiOutput(
        JSON.stringify({
          samplingPresets: [{ description: "no name", params: {} }],
        }),
      ),
    ).toThrow('samplingPresets[0]: "name" must be a non-empty string');
  });

  test("rejects preset with invalid param value type", () => {
    expect(() =>
      parseAndValidatePiOutput(
        JSON.stringify({
          samplingPresets: [
            { name: "x", description: "", params: { temp: null } },
          ],
        }),
      ),
    ).toThrow("samplingPresets[0].params.temp: expected number|string|boolean");
  });

  test("accepts boolean and string param values", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({
        samplingPresets: [
          {
            name: "flaggy",
            description: "test",
            params: { stream: true, mode: "creative" },
          },
        ],
      }),
    );

    expect(result.samplingPresets[0]!.params.stream).toBe(true);
    expect(result.samplingPresets[0]!.params.mode).toBe("creative");
  });

  test("parses a valid prices array with cached and uncached entries", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({
        prices: [
          {
            completionWindow: "standard",
            inputPerMTok: 0.2,
            cachedInputPerMTok: 0.1,
            outputPerMTok: 1.2,
          },
          {
            completionWindow: "flex",
            inputPerMTok: 0.16,
            cachedInputPerMTok: null,
            outputPerMTok: 0.8,
          },
        ],
      }),
    );

    expect(result.prices).toHaveLength(2);
    expect(result.prices[0]).toEqual({
      completionWindow: "standard",
      inputPerMTok: 0.2,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 1.2,
    });
    expect(result.prices[1]!.cachedInputPerMTok).toBeNull();
  });

  test("rejects price entry with invalid completionWindow", () => {
    expect(() =>
      parseAndValidatePiOutput(
        JSON.stringify({
          prices: [
            {
              completionWindow: "bogus",
              inputPerMTok: 1,
              outputPerMTok: 2,
            },
          ],
        }),
      ),
    ).toThrow('"completionWindow" must be one of asap|priority|standard|flex');
  });

  test("rejects price entry with non-numeric input price", () => {
    expect(() =>
      parseAndValidatePiOutput(
        JSON.stringify({
          prices: [
            {
              completionWindow: "flex",
              inputPerMTok: "cheap",
              outputPerMTok: 2,
            },
          ],
        }),
      ),
    ).toThrow('"inputPerMTok" must be a number');
  });

  test("rejects duplicate completionWindow entries", () => {
    expect(() =>
      parseAndValidatePiOutput(
        JSON.stringify({
          prices: [
            { completionWindow: "flex", inputPerMTok: 1, outputPerMTok: 2 },
            { completionWindow: "flex", inputPerMTok: 3, outputPerMTok: 4 },
          ],
        }),
      ),
    ).toThrow('duplicate completionWindow "flex"');
  });

  test("parses supportsImage true", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ supportsImage: true }),
    );
    expect(result.supportsImage).toBe(true);
  });

  test("parses supportsImage false", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ supportsImage: false }),
    );
    expect(result.supportsImage).toBe(false);
  });

  test("defaults supportsImage to false when absent", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ contextSize: 8192 }),
    );
    expect(result.supportsImage).toBe(false);
  });

  test("parses reasoning true", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ reasoning: true }),
    );
    expect(result.reasoning).toBe(true);
  });

  test("parses reasoning false", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ reasoning: false }),
    );
    expect(result.reasoning).toBe(false);
  });

  test("defaults reasoning to false when absent", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ contextSize: 8192 }),
    );
    expect(result.reasoning).toBe(false);
  });

  test("rejects reasoning with wrong type", () => {
    expect(() =>
      parseAndValidatePiOutput(JSON.stringify({ reasoning: "yes" })),
    ).toThrow('"reasoning" must be a boolean or null');
  });

  test("parses thinkingLevelMap with valid entries", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
      }),
    );
    expect(result.reasoning).toBe(true);
    expect(result.thinkingLevelMap).toEqual({
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  test("ignores invalid thinkingLevelMap keys", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({
        reasoning: true,
        thinkingLevelMap: {
          low: "low",
          bogus: "ignored",
        },
      }),
    );
    expect(result.thinkingLevelMap).toEqual({ low: "low" });
  });

  test("returns null thinkingLevelMap when absent", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ reasoning: false }),
    );
    expect(result.thinkingLevelMap).toBeNull();
  });

  test("returns null thinkingLevelMap for non-object input", () => {
    const result = parseAndValidatePiOutput(
      JSON.stringify({ thinkingLevelMap: "oops" }),
    );
    expect(result.thinkingLevelMap).toBeNull();
  });

  test("extracts JSON from LLM output with text before the object", () => {
    const result = parseAndValidatePiOutput(
      'Here is the data.{{"contextSize": 8192, "reasoning": false}}'.replace(
        "{{",
        "{",
      ),
    );
    expect(result.contextSize).toBe(8192);
    expect(result.reasoning).toBe(false);
  });
});

// ─── Smoke test preset tests ──────────────────────────────────────────────────

describe("smokeTestPreset", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns ok:true on 200 response with content", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "42" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as any;

    const result = await smokeTestPreset("test-model", {
      temperature: 0.7,
    });
    expect(result.ok).toBe(true);
    expect(result.thinkingLevel).toBeNull();
  });

  test("returns ok:false on non-2xx response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Invalid temperature value" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as any;

    const result = await smokeTestPreset("test-model", {
      temperature: "creative",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid temperature value");
  });

  test("returns ok:false on fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as any;

    const result = await smokeTestPreset("test-model", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  test("sends reasoning_effort when thinkingLevel is provided", async () => {
    let capturedBody: any;
    globalThis.fetch = mock((_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "59" } }],
          }),
          { status: 200 },
        ),
      );
    }) as any;

    const result = await smokeTestPreset(
      "test-model",
      { temperature: 0.5 },
      "high",
    );
    expect(result.ok).toBe(true);
    expect(capturedBody.reasoning_effort).toBe("high");
    expect(capturedBody.model).toBe("test-model");
    expect(capturedBody.temperature).toBe(0.5);
    // Prompt should be a unique arithmetic question, not a static string
    expect(capturedBody.messages[0].content).toMatch(
      /^What is \d+ \+ \d+\? Reply with just the number\.$/,
    );
  });

  test("returns ok:false on empty response content", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" } }],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await smokeTestPreset("test-model", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty response content");
  });

  test("marks timedOut when fetch rejects with TimeoutError", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    ) as any;

    const result = await smokeTestPreset("test-model", {});
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out after");
  });

  test("does not mark timedOut on ordinary fetch errors", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as any;

    const result = await smokeTestPreset("test-model", {});
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  test("aborts a hung request via the timeout signal (regression: infinite hang)", async () => {
    // Mock fetch that never resolves on its own — only rejects when the
    // caller's AbortSignal fires. Before the timeout fix this hung forever.
    globalThis.fetch = mock(
      (_url: any, opts: any) =>
        new Promise((_resolve, reject) => {
          const signal: AbortSignal = opts.signal;
          expect(signal).toBeDefined();
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out", "TimeoutError")),
          );
        }),
    ) as any;

    const result = await smokeTestPreset(
      "test-model",
      {},
      null,
      "http://localhost:4000/v1/chat/completions",
      10, // 10 ms timeout
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe("smokeTestPresets", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  const defaultPreset: SamplingPresetInput = {
    name: "default",
    description: "General purpose",
    params: { temperature: 0.7, top_p: 0.95 },
  };
  const codingPreset: SamplingPresetInput = {
    name: "coding",
    description: "Coding tasks",
    params: { temperature: 0.2, top_p: 0.9 },
  };

  test("filters out failing presets and keeps passing ones", async () => {
    // Key the mock off the request body, not call order — preset tests
    // run concurrently, so arrival order is not guaranteed.
    globalThis.fetch = mock((_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      // default preset (temperature 0.7) passes, coding (0.2) fails
      if (body.temperature === 0.7) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "42" } }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Bad params" },
          }),
          { status: 400 },
        ),
      );
    }) as any;

    const results = await smokeTestPresets(
      "test-model",
      [defaultPreset, codingPreset],
      null,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.presetName).toBe("default");
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.presetName).toBe("coding");
    expect(results[1]!.ok).toBe(false);
  });

  test("removes thinking level from thinkingLevelMap when it fails but base params pass", async () => {
    // Key the mock off reasoning_effort presence, not call order — preset
    // tests run concurrently, so arrival order is not guaranteed.
    globalThis.fetch = mock((_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.reasoning_effort === undefined) {
        // Base params pass
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "42" } }],
            }),
            { status: 200 },
          ),
        );
      }
      // Thinking level fails
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Reasoning not supported" },
          }),
          { status: 400 },
        ),
      );
    }) as any;

    const results = await smokeTestPresets("test-model", [defaultPreset], {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    });

    // Should have 2 results: base params + thinking level
    expect(results).toHaveLength(2);
    expect(results[0]!.thinkingLevel).toBeNull();
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.thinkingLevel).toBe("high");
    expect(results[1]!.ok).toBe(false);
  });

  test("returns empty results for all-failing presets", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Invalid model" },
          }),
          { status: 400 },
        ),
      ),
    ) as any;

    const results = await smokeTestPresets(
      "bad-model",
      [defaultPreset, codingPreset],
      null,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

// ─── Window compatibility smoke test ──────────────────────────────────────

describe("chatCompletionsUrlForWindow", () => {
  test("builds /asap/v1/chat/completions for asap", () => {
    const url = chatCompletionsUrlForWindow("http://localhost:4000/v1", "asap");
    expect(url).toBe("http://localhost:4000/asap/v1/chat/completions");
  });

  test("builds /flex/v1/chat/completions for flex", () => {
    const url = chatCompletionsUrlForWindow("http://localhost:4000/v1", "flex");
    expect(url).toBe("http://localhost:4000/flex/v1/chat/completions");
  });

  test("no prefix for standard", () => {
    const url = chatCompletionsUrlForWindow(
      "http://localhost:4000/v1",
      "standard",
    );
    expect(url).toBe("http://localhost:4000/v1/chat/completions");
  });

  test("handles base URL without /v1", () => {
    const url = chatCompletionsUrlForWindow("http://localhost:4000", "asap");
    expect(url).toBe("http://localhost:4000/asap/v1/chat/completions");
  });
});

describe("smokeTestWindowCompatibility", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns only windows that respond 200", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      urls.push(url);
      // asap and flex return 200, priority and standard return 400
      if (url.includes("/asap/") || url.includes("/flex/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "42" } }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "window not available" },
          }),
          { status: 400 },
        ),
      );
    }) as any;

    const result = await smokeTestWindowCompatibility(
      "test-model",
      "http://localhost:4000/v1",
    );

    expect(result.supported.size).toBe(2);
    expect(result.supported.has("asap")).toBe(true);
    expect(result.supported.has("flex")).toBe(true);
    expect(result.supported.has("standard")).toBe(false);
    expect(result.supported.has("priority")).toBe(false);
    expect(result.timedOut.size).toBe(0);
  });

  test("returns all windows when all respond 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "42" } }],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await smokeTestWindowCompatibility(
      "test-model",
      "http://localhost:4000/v1",
    );

    expect(result.supported.size).toBe(4);
    expect([...result.supported].sort()).toEqual([
      "asap",
      "flex",
      "priority",
      "standard",
    ]);
  });

  test("returns empty set when all windows fail", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "not available" },
          }),
          { status: 400 },
        ),
      ),
    ) as any;

    const result = await smokeTestWindowCompatibility(
      "test-model",
      "http://localhost:4000/v1",
    );

    expect(result.supported.size).toBe(0);
    expect(result.timedOut.size).toBe(0);
  });

  test("a window that times out lands in timedOut, not supported", async () => {
    globalThis.fetch = mock((url: string, opts: any) => {
      if (url.includes("/flex/")) {
        // Hang until the caller's timeout signal aborts
        return new Promise((_resolve, reject) => {
          (opts.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("The operation timed out", "TimeoutError")),
          );
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "42" } }],
          }),
          { status: 200 },
        ),
      );
    }) as any;

    const result = await smokeTestWindowCompatibility(
      "test-model",
      "http://localhost:4000/v1",
      10, // 10 ms timeout
    );

    expect(result.timedOut.size).toBe(1);
    expect(result.timedOut.has("flex")).toBe(true);
    expect(result.supported.has("flex")).toBe(false);
    expect([...result.supported].sort()).toEqual([
      "asap",
      "priority",
      "standard",
    ]);
  });
});

describe("pickBestWindow", () => {
  const windows = (...ws: CompletionWindow[]) => new Set<CompletionWindow>(ws);

  test("prefers asap when supported", () => {
    expect(
      pickBestWindow(windows("flex", "standard", "asap", "priority")),
    ).toBe("asap");
  });

  test("falls back through priority > standard > flex", () => {
    expect(pickBestWindow(windows("flex", "standard", "priority"))).toBe(
      "priority",
    );
    expect(pickBestWindow(windows("flex", "standard"))).toBe("standard");
    expect(pickBestWindow(windows("flex"))).toBe("flex");
  });

  test("returns the configured research window when compatibility is unknown", () => {
    expect(pickBestWindow(null)).toBe("asap");
    expect(pickBestWindow(windows())).toBe("asap");
  });
});

describe("smokeTimeoutForWindow", () => {
  test("is the window's server bound plus slack", () => {
    const slack = config.research.smokeTimeoutSlackMs;
    expect(smokeTimeoutForWindow("asap")).toBe(
      config.sail.inferenceTimeoutMs + slack,
    );
    expect(smokeTimeoutForWindow("priority")).toBe(
      config.windowTimeouts.priority + slack,
    );
    expect(smokeTimeoutForWindow("standard")).toBe(
      config.windowTimeouts.standard + slack,
    );
    expect(smokeTimeoutForWindow("flex")).toBe(
      config.windowTimeouts.flex + slack,
    );
  });

  test("flex gets its full 2h window (regression: flex must complete)", () => {
    expect(smokeTimeoutForWindow("flex")).toBeGreaterThanOrEqual(
      2 * 60 * 60 * 1000,
    );
  });
});
