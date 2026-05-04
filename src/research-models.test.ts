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
  });

  test("handles null fields gracefully", () => {
    const result = parseAndValidatePiOutput("{}");

    expect(result.contextSize).toBeNull();
    expect(result.samplingPresets).toEqual([]);
    expect(result.description).toBeNull();
    expect(result.source).toBeNull();
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
});
