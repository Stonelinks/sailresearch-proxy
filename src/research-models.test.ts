import { describe, test, expect, mock, beforeAll, beforeEach } from "bun:test";
import {
  parseAndValidatePiOutput,
  smokeTestPreset,
  smokeTestPresets,
} from "./research-models.ts";
import type { SamplingPresetInput } from "./types.ts";

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
                message: { content: "Hello!" },
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
            choices: [{ message: { content: "Thinking..." } }],
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
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      // First preset passes, second fails
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Hi!" } }],
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
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      // Base params (call 1) pass, thinking level (call 2) fails
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Hi!" } }],
            }),
            { status: 200 },
          ),
        );
      }
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
