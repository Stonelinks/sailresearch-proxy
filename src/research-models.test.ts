import { describe, test, expect } from "bun:test";
import { parseAndValidatePiOutput } from "./research-models.ts";

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
    expect(() => parseAndValidatePiOutput("not json")).toThrow("Invalid JSON");
  });

  test("rejects non-object JSON", () => {
    expect(() => parseAndValidatePiOutput("[]")).toThrow(
      "Expected a JSON object",
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
});
