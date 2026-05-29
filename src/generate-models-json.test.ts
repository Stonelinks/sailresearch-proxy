import { describe, test, expect } from "bun:test";
import {
  buildPiModelEntry,
  buildProvider,
  buildModelName,
  inferThinkingFormat,
  restShapeToModelData,
  type ModelData,
} from "./generate-models-json.ts";
import type { PresetWire, PriceWire } from "./models-meta.ts";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeModelData(overrides: Partial<ModelData> = {}): ModelData {
  return {
    modelId: "test-org/test-model",
    contextSize: 131072,
    description: "A test model",
    supportsImage: false,
    reasoning: false,
    thinkingLevelMap: null,
    supportedWindows: new Set(["asap", "priority", "standard", "flex"]),
    samplingPresets: [
      {
        name: "default",
        description: "General purpose",
        params: { temperature: 0.7, top_p: 0.95 },
      },
    ],
    pricesByWindow: new Map([
      [
        "standard",
        {
          completionWindow: "standard",
          inputPerMTok: 0.2,
          cachedInputPerMTok: 0.1,
          outputPerMTok: 1.2,
          currency: "USD",
        },
      ],
    ]),
    ...overrides,
  };
}

function makePrice(overrides: Partial<PriceWire> = {}): PriceWire {
  return {
    completionWindow: "standard",
    inputPerMTok: 0.2,
    cachedInputPerMTok: 0.1,
    outputPerMTok: 1.2,
    currency: "USD",
    ...overrides,
  };
}

function makePreset(overrides: Partial<PresetWire> = {}): PresetWire {
  return {
    name: "default",
    description: "General purpose",
    params: { temperature: 0.7, top_p: 0.95 },
    ...overrides,
  };
}

// ─── inferThinkingFormat ────────────────────────────────────────────────────

describe("inferThinkingFormat", () => {
  test("returns 'zai' for zai-org models", () => {
    expect(inferThinkingFormat("zai-org/GLM-5.1-FP8")).toBe("zai");
  });

  test("returns 'deepseek' for deepseek-ai models", () => {
    expect(inferThinkingFormat("deepseek-ai/DeepSeek-V3.2")).toBe("deepseek");
    expect(inferThinkingFormat("deepseek-ai/DeepSeek-V4-Pro")).toBe("deepseek");
  });

  test("returns 'qwen' for Qwen models", () => {
    expect(inferThinkingFormat("Qwen/Qwen3-235B-A22B")).toBe("qwen");
  });

  test("returns undefined for unknown orgs", () => {
    expect(inferThinkingFormat("moonshotai/Kimi-K2.5")).toBeUndefined();
    expect(inferThinkingFormat("openai/gpt-oss-20b")).toBeUndefined();
    expect(inferThinkingFormat("MiniMaxAI/MiniMax-M2.7")).toBeUndefined();
  });
});

// ─── buildModelName ─────────────────────────────────────────────────────────

describe("buildModelName", () => {
  test("extracts short name from org/model-id", () => {
    expect(buildModelName("moonshotai/Kimi-K2.5")).toBe("Kimi K2 5");
  });

  test("handles model IDs without org prefix", () => {
    expect(buildModelName("my-model")).toBe("My Model");
  });

  test("appends preset name for non-default presets", () => {
    expect(buildModelName("moonshotai/Kimi-K2.5", "thinking")).toBe(
      "Kimi K2 5 (thinking)",
    );
  });

  test("does not append preset name for default preset", () => {
    expect(buildModelName("moonshotai/Kimi-K2.5", "default")).toBe("Kimi K2 5");
  });

  test("handles dots in model IDs", () => {
    expect(buildModelName("org/model.v2")).toBe("Model V2");
  });
});

// ─── buildPiModelEntry ──────────────────────────────────────────────────────

describe("buildPiModelEntry", () => {
  test("creates basic entry for non-reasoning text-only model", () => {
    const data = makeModelData();
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.id).toBe("test-org/test-model");
    expect(entry.name).toBe("Test Model");
    expect(entry.reasoning).toBeUndefined();
    expect(entry.input).toBeUndefined();
    expect(entry.contextWindow).toBe(131072);
    expect(entry.cost).toEqual({
      input: 0.2,
      output: 1.2,
      cacheRead: 0.1,
      cacheWrite: 0,
    });
    expect(entry.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
  });

  test("includes input: ['text', 'image'] for multimodal model", () => {
    const data = makeModelData({ supportsImage: true });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.input).toEqual(["text", "image"]);
  });

  test("includes reasoning and thinkingLevelMap for reasoning model", () => {
    const data = makeModelData({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      },
    });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.reasoning).toBe(true);
    expect(entry.thinkingLevelMap).toEqual({
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  test("adds thinkingFormat for zai-org reasoning model", () => {
    const data = makeModelData({
      modelId: "zai-org/GLM-5.1-FP8",
      reasoning: true,
    });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.compat?.thinkingFormat).toBe("zai");
    expect(entry.compat?.supportsDeveloperRole).toBe(true);
    expect(entry.compat?.supportsReasoningEffort).toBe(true);
  });

  test("adds thinkingFormat for deepseek reasoning model", () => {
    const data = makeModelData({
      modelId: "deepseek-ai/DeepSeek-V4-Pro",
      reasoning: true,
    });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.compat?.thinkingFormat).toBe("deepseek");
  });

  test("uses preset name in id for non-default presets", () => {
    const data = makeModelData();
    const preset = makePreset({
      name: "creative",
      params: { temperature: 1.0 },
    });
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.id).toBe("test-org/test-model::creative");
    expect(entry.name).toBe("Test Model (creative)");
  });

  test("extracts maxTokens from preset params", () => {
    const data = makeModelData();
    const preset = makePreset({
      params: { temperature: 0.7, max_tokens: 8192 },
    });
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.maxTokens).toBe(8192);
  });

  test("extracts maxTokens from max_completion_tokens param", () => {
    const data = makeModelData();
    const preset = makePreset({
      params: { temperature: 0.7, max_completion_tokens: 16384 },
    });
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.maxTokens).toBe(16384);
  });

  test("omits maxTokens when not in preset params", () => {
    const data = makeModelData();
    const preset = makePreset({ params: { temperature: 0.7 } });
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.maxTokens).toBeUndefined();
  });

  test("omits contextWindow when null", () => {
    const data = makeModelData({ contextSize: null });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.contextWindow).toBeUndefined();
  });

  test("handles null cachedInputPerMTok in cost", () => {
    const data = makeModelData();
    const preset = makePreset();
    const price = makePrice({ cachedInputPerMTok: null });

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.cost?.cacheRead).toBe(0);
  });

  test("omits cost when price is null", () => {
    const data = makeModelData();
    const preset = makePreset();

    const entry = buildPiModelEntry(data, preset, null);

    expect(entry.id).toBe("test-org/test-model");
    expect(entry.cost).toBeUndefined();
  });

  test("combines reasoning + multimodal", () => {
    const data = makeModelData({
      supportsImage: true,
      reasoning: true,
      thinkingLevelMap: { low: "low", high: "high" },
    });
    const preset = makePreset();
    const price = makePrice();

    const entry = buildPiModelEntry(data, preset, price);

    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.reasoning).toBe(true);
    expect(entry.thinkingLevelMap).toEqual({ low: "low", high: "high" });
  });
});

// ─── buildProvider ──────────────────────────────────────────────────────────

describe("buildProvider", () => {
  test("builds standard provider with no URL prefix", () => {
    const modelsData = new Map([
      ["org/model", makeModelData({ modelId: "org/model" })],
    ]);

    const provider = buildProvider(
      "standard",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider).not.toBeNull();
    expect(provider!.baseUrl).toBe("http://localhost:4000/v1");
    expect(provider!.api).toBe("openai-completions");
    expect(provider!.models).toHaveLength(1);
  });

  test("appends /v1 to standard provider when base URL has no /v1", () => {
    // Regression: `generate-models-json --base-url https://host` (no /v1)
    // must still produce a /v1 path, otherwise pi POSTs to {host}/chat/completions
    // and the proxy returns 404.
    const modelsData = new Map([
      ["org/model", makeModelData({ modelId: "org/model" })],
    ]);

    const provider = buildProvider(
      "standard",
      modelsData,
      "https://llm3.cricket.routers.stonelinks.org",
    );

    expect(provider).not.toBeNull();
    expect(provider!.baseUrl).toBe(
      "https://llm3.cricket.routers.stonelinks.org/v1",
    );
  });

  test("appends /asap/v1 to asap provider when base URL has no /v1", () => {
    const price = makePrice({ completionWindow: "asap" });
    const data = makeModelData({
      modelId: "org/model",
      pricesByWindow: new Map([["asap", price]]),
    });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "asap",
      modelsData,
      "https://llm3.cricket.routers.stonelinks.org",
    );

    expect(provider).not.toBeNull();
    expect(provider!.baseUrl).toBe(
      "https://llm3.cricket.routers.stonelinks.org/asap/v1",
    );
  });

  test("builds asap provider with /asap/v1 prefix", () => {
    const price = makePrice({ completionWindow: "asap" });
    const data = makeModelData({
      modelId: "org/model",
      pricesByWindow: new Map([["asap", price]]),
    });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "asap",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider).not.toBeNull();
    expect(provider!.baseUrl).toBe("http://localhost:4000/asap/v1");
  });

  test("builds flex provider with /flex/v1 prefix", () => {
    const price = makePrice({ completionWindow: "flex" });
    const data = makeModelData({
      modelId: "org/model",
      pricesByWindow: new Map([["flex", price]]),
    });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "flex",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider).not.toBeNull();
    expect(provider!.baseUrl).toBe("http://localhost:4000/flex/v1");
  });

  test("includes models without pricing for that window (no cost field)", () => {
    // Model only has standard pricing, not asap
    const data = makeModelData({ modelId: "org/model" });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "asap",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider).not.toBeNull();
    expect(provider!.models).toHaveLength(1);
    expect(provider!.models[0]!.cost).toBeUndefined();
  });

  test("includes model with no pricing at all in any window", () => {
    const data = makeModelData({
      modelId: "org/no-price-model",
      pricesByWindow: new Map(),
    });
    const modelsData = new Map([["org/no-price-model", data]]);

    const provider = buildProvider(
      "standard",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider).not.toBeNull();
    expect(provider!.models).toHaveLength(1);
    expect(provider!.models[0]!.id).toBe("org/no-price-model");
    expect(provider!.models[0]!.cost).toBeUndefined();
  });

  test("creates multiple entries for model with multiple presets", () => {
    const data = makeModelData({
      modelId: "org/model",
      samplingPresets: [
        {
          name: "default",
          description: "Default",
          params: { temperature: 0.7 },
        },
        {
          name: "creative",
          description: "Creative",
          params: { temperature: 1.0 },
        },
      ],
    });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "standard",
      modelsData,
      "http://localhost:4000/v1",
    );

    expect(provider!.models).toHaveLength(2);
    expect(provider!.models[0]!.id).toBe("org/model");
    expect(provider!.models[1]!.id).toBe("org/model::creative");
  });

  test("creates default preset entry for model with no presets", () => {
    const provider = buildProvider(
      "standard",
      new Map([["no-presets", makeModelData({ samplingPresets: [] })]]),
      "http://localhost:4000/v1",
    );
    expect(provider).not.toBeNull();
    expect(provider!.models[0]!.id).toBe("test-org/test-model");
  });

  test("excludes models that don't support the target window", () => {
    const provider = buildProvider(
      "standard",
      new Map([
        [
          "asap-only",
          makeModelData({
            modelId: "asap-only",
            supportedWindows: new Set(["asap"]),
          }),
        ],
        [
          "all-windows",
          makeModelData({
            modelId: "all-windows",
            supportedWindows: new Set(["asap", "priority", "standard", "flex"]),
          }),
        ],
      ]),
      "http://localhost:4000/v1",
    );
    expect(provider).not.toBeNull();
    const ids = provider!.models.map((m) => m.id);
    expect(ids).toContain("all-windows");
    expect(ids).not.toContain("asap-only");
  });

  test("includes models with empty supportedWindows (not yet tested)", () => {
    const provider = buildProvider(
      "standard",
      new Map([
        [
          "untested",
          makeModelData({
            modelId: "untested",
            supportedWindows: new Set(),
          }),
        ],
      ]),
      "http://localhost:4000/v1",
    );
    expect(provider).not.toBeNull();
    expect(provider!.models[0]!.id).toBe("untested");
  });

  test("handles base URL without /v1 suffix", () => {
    const price = makePrice({ completionWindow: "priority" });
    const data = makeModelData({
      modelId: "org/model",
      pricesByWindow: new Map([["priority", price]]),
    });
    const modelsData = new Map([["org/model", data]]);

    const provider = buildProvider(
      "priority",
      modelsData,
      "http://localhost:4000",
    );

    expect(provider!.baseUrl).toBe("http://localhost:4000/priority/v1");
  });
});

// ─── restShapeToModelData ────────────────────────────────────────────────────

describe("restShapeToModelData", () => {
  test("converts full /v1/models entry with all fields", () => {
    const entry = {
      id: "org/test-model",
      object: "model",
      created: 1700000000,
      owned_by: "org",
      context_length: 131072,
      description: "A test model",
      supports_image: true,
      reasoning: true,
      thinking_level_map: { off: null, low: "low", high: "high" },
      default_parameters: { temperature: 0.7 },
      x_sampling_presets: [
        {
          name: "default",
          description: "General",
          params: { temperature: 0.7 },
        },
        {
          name: "creative",
          description: "Creative",
          params: { temperature: 1.0 },
        },
      ],
      x_pricing_by_completion_window: [
        {
          completion_window: "standard",
          input_per_mtok: 0.2,
          cached_input_per_mtok: 0.1,
          output_per_mtok: 1.2,
          currency: "USD",
        },
        {
          completion_window: "flex",
          input_per_mtok: 0.16,
          output_per_mtok: 0.8,
          currency: "USD",
        },
      ],
    };

    const data = restShapeToModelData(entry);

    expect(data.modelId).toBe("org/test-model");
    expect(data.contextSize).toBe(131072);
    expect(data.description).toBe("A test model");
    expect(data.supportsImage).toBe(true);
    expect(data.reasoning).toBe(true);
    expect(data.thinkingLevelMap).toEqual({
      off: null,
      low: "low",
      high: "high",
    });
    expect(data.samplingPresets).toHaveLength(2);
    expect(data.samplingPresets[0]!.name).toBe("default");
    expect(data.samplingPresets[1]!.name).toBe("creative");
    expect(data.pricesByWindow.size).toBe(2);
    expect(data.pricesByWindow.get("standard")!.inputPerMTok).toBe(0.2);
    expect(data.pricesByWindow.get("flex")!.inputPerMTok).toBe(0.16);
    expect(data.pricesByWindow.get("flex")!.cachedInputPerMTok).toBeNull();
  });

  test("converts minimal /v1/models entry with only canonical fields", () => {
    const entry = {
      id: "org/plain-model",
      object: "model",
      created: 1,
      owned_by: "org",
    };

    const data = restShapeToModelData(entry);

    expect(data.modelId).toBe("org/plain-model");
    expect(data.contextSize).toBeNull();
    expect(data.description).toBeNull();
    expect(data.supportsImage).toBe(false);
    expect(data.reasoning).toBe(false);
    expect(data.thinkingLevelMap).toBeNull();
    expect(data.samplingPresets).toEqual([]);
    expect(data.pricesByWindow.size).toBe(0);
  });

  test("creates default preset from default_parameters when no x_sampling_presets", () => {
    const entry = {
      id: "org/model",
      default_parameters: { temperature: 0.5, top_p: 0.9 },
    };

    const data = restShapeToModelData(entry);

    expect(data.samplingPresets).toHaveLength(1);
    expect(data.samplingPresets[0]!.name).toBe("default");
    expect(data.samplingPresets[0]!.params).toEqual({
      temperature: 0.5,
      top_p: 0.9,
    });
  });

  test("handles missing id gracefully", () => {
    const data = restShapeToModelData({});
    expect(data.modelId).toBe("unknown");
  });

  test("ignores invalid completion windows in pricing", () => {
    const entry = {
      id: "org/model",
      x_pricing_by_completion_window: [
        {
          completion_window: "bogus",
          input_per_mtok: 1,
          output_per_mtok: 2,
          currency: "USD",
        },
        {
          completion_window: "standard",
          input_per_mtok: 0.2,
          output_per_mtok: 1.2,
          currency: "USD",
        },
      ],
    };

    const data = restShapeToModelData(entry);
    expect(data.pricesByWindow.size).toBe(1);
    expect(data.pricesByWindow.get("standard")).toBeDefined();
  });

  test("handles camelCase completionWindow in pricing", () => {
    const entry = {
      id: "org/model",
      x_pricing_by_completion_window: [
        {
          completionWindow: "asap",
          inputPerMTok: 0.5,
          outputPerMTok: 2.0,
          currency: "USD",
        },
      ],
    };

    const data = restShapeToModelData(entry);
    expect(data.pricesByWindow.get("asap")!.inputPerMTok).toBe(0.5);
  });

  test("parses x_supported_windows from API response", () => {
    const entry = {
      id: "org/model",
      x_supported_windows: ["asap", "flex"],
    };

    const data = restShapeToModelData(entry);
    expect(data.supportedWindows).toEqual(new Set(["asap", "flex"]));
  });

  test("ignores invalid values in x_supported_windows", () => {
    const entry = {
      id: "org/model",
      x_supported_windows: ["asap", "bogus", "standard", 42],
    };

    const data = restShapeToModelData(entry);
    expect(data.supportedWindows).toEqual(new Set(["asap", "standard"]));
  });

  test("defaults to empty set when x_supported_windows is absent", () => {
    const entry = { id: "org/model" };
    const data = restShapeToModelData(entry);
    expect(data.supportedWindows).toEqual(new Set());
  });
});
