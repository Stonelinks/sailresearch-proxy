/**
 * Tests for `/v1/models` REST handler. We mock both the Sail client and the
 * Prisma module so we can exercise the merge-and-project pipeline without
 * touching the network or the DB.
 */
import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const mockListModels = mock<() => Promise<{ status: number; data: any }>>();
mock.module("../sail-client.ts", () => ({
  sail: { listModels: mockListModels },
}));

const mockModelMetaFindMany = mock();
mock.module("../db.ts", () => ({
  prisma: {
    modelMeta: { findMany: mockModelMetaFindMany },
  },
}));

const { handleModels } = await import("./models.ts");

function reqWithWindow(window?: string): Request {
  const headers = new Headers();
  if (window) headers.set("x-completion-window", window);
  return new Request("http://x/v1/models", { headers });
}

describe("handleModels", () => {
  beforeEach(() => {
    mockListModels.mockReset();
    mockModelMetaFindMany.mockReset();
  });

  test("emits OpenRouter-style enriched fields for researched models", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        object: "list",
        data: [
          {
            id: "model-a",
            object: "model",
            created: 1700000000,
            owned_by: "org-a",
          },
        ],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "model-a",
        contextSize: 131072,
        description: "Big model",
        source: "https://hf.co/org-a/model-a",
        researchedAt: new Date("2025-06-01T00:00:00Z"),
        supportedWindows: '["asap","priority","standard","flex"]',
        samplingPresets: [
          {
            name: "default",
            description: "General",
            params: '{"temperature":0.7,"top_p":0.95}',
          },
          {
            name: "creative",
            description: "Higher temp",
            params: '{"temperature":1.2,"top_k":50}',
          },
        ],
        prices: [
          {
            completionWindow: "standard",
            inputPerMTok: 0.2,
            cachedInputPerMTok: 0.1,
            outputPerMTok: 1.2,
            currency: "USD",
          },
          {
            completionWindow: "flex",
            inputPerMTok: 0.16,
            cachedInputPerMTok: 0.05,
            outputPerMTok: 0.8,
            currency: "USD",
          },
        ],
      },
    ]);

    const res = await handleModels(reqWithWindow());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);

    const m = body.data[0];
    // Canonical OpenAI fields preserved.
    expect(m.id).toBe("model-a");
    expect(m.object).toBe("model");
    expect(m.created).toBe(1700000000);
    expect(m.owned_by).toBe("org-a");
    // OpenRouter convention: context_length top-level + mirrored on top_provider.
    expect(m.context_length).toBe(131072);
    expect(m.top_provider).toEqual({ context_length: 131072 });
    expect(m.description).toBe("Big model");
    // default_parameters comes from the preset named "default".
    expect(m.default_parameters).toEqual({ temperature: 0.7, top_p: 0.95 });
    // supported_parameters is the sorted union across presets.
    expect(m.supported_parameters).toEqual(["temperature", "top_k", "top_p"]);
    // Namespaced extension carries the full preset list.
    expect(m.x_sampling_presets).toHaveLength(2);
    expect(m.x_sampling_presets[0]).toEqual({
      name: "default",
      description: "General",
      params: { temperature: 0.7, top_p: 0.95 },
    });
    expect(m.x_source).toBe("https://hf.co/org-a/model-a");
    expect(m.x_researched_at).toBe("2025-06-01T00:00:00.000Z");
    // Default unprefixed window is "standard" → mirror standard pricing.
    // Prices are USD per token as fixed-decimal strings (OpenRouter convention).
    expect(m.pricing).toEqual({
      prompt: "0.0000002",
      completion: "0.0000012",
      input_cache_read: "0.0000001",
    });
    expect(m.x_billing_window).toBeUndefined();
    expect(m.x_pricing_by_completion_window).toEqual([
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
        cached_input_per_mtok: 0.05,
        output_per_mtok: 0.8,
        currency: "USD",
      },
    ]);
    // supportedWindows is surfaced as x_supported_windows
    expect(m.x_supported_windows).toEqual([
      "asap",
      "priority",
      "standard",
      "flex",
    ]);
  });

  test("omits enrichment fields entirely for un-researched models", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        object: "list",
        data: [
          {
            id: "model-b",
            object: "model",
            created: 1700000001,
            owned_by: "org-b",
          },
        ],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([]);

    const res = await handleModels(reqWithWindow());
    const body: any = await res.json();
    const m = body.data[0];

    // Canonical fields only.
    expect(Object.keys(m).sort()).toEqual([
      "created",
      "id",
      "object",
      "owned_by",
    ]);
  });

  test("falls back to first preset when no preset is named 'default'", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 4096,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: null,
        samplingPresets: [
          { name: "creative", description: "", params: '{"temperature":1.2}' },
          {
            name: "deterministic",
            description: "",
            params: '{"temperature":0}',
          },
        ],
        prices: [],
      },
    ]);

    const res = await handleModels(reqWithWindow());
    const body: any = await res.json();
    expect(body.data[0].default_parameters).toEqual({ temperature: 1.2 });
  });

  test("propagates upstream error via mapSailError", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 503,
      data: { error: { message: "upstream down" } },
    });

    const res = await handleModels(reqWithWindow());
    // mapSailError translates upstream 5xx → 502 Bad Gateway.
    expect(res.status).toBe(502);
    expect(mockModelMetaFindMany).not.toHaveBeenCalled();
  });

  test("handles malformed preset JSON without crashing", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 2048,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: null,
        samplingPresets: [
          { name: "broken", description: "", params: "{not json" },
        ],
        prices: [],
      },
    ]);

    const res = await handleModels(reqWithWindow());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data[0].default_parameters).toEqual({});
    expect(body.data[0].supported_parameters).toEqual([]);
    expect(body.data[0].pricing).toBeUndefined();
    expect(body.data[0].x_pricing_by_completion_window).toBeUndefined();
  });

  test("x-completion-window header selects the pricing mirror", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: null,
        samplingPresets: [],
        prices: [
          {
            completionWindow: "standard",
            inputPerMTok: 1,
            cachedInputPerMTok: null,
            outputPerMTok: 5,
            currency: "USD",
          },
          {
            completionWindow: "flex",
            inputPerMTok: 0.5,
            cachedInputPerMTok: null,
            outputPerMTok: 2.5,
            currency: "USD",
          },
        ],
      },
    ]);

    const res = await handleModels(reqWithWindow("flex"));
    const body: any = await res.json();
    expect(body.data[0].pricing).toEqual({
      prompt: "0.0000005",
      completion: "0.0000025",
    });
    expect(body.data[0].x_billing_window).toBeUndefined();
  });

  test("falls back to flex pricing with x_billing_window when window is missing", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 1,
        description: null,
        source: null,
        supportedWindows: null,
        researchedAt: new Date(),
        samplingPresets: [],
        prices: [
          {
            completionWindow: "flex",
            inputPerMTok: 0.04,
            cachedInputPerMTok: 0.01,
            outputPerMTok: 0.25,
            currency: "USD",
          },
        ],
      },
    ]);

    // Ask for "priority" — model only publishes flex.
    const res = await handleModels(reqWithWindow("priority"));
    const body: any = await res.json();
    expect(body.data[0].pricing).toEqual({
      prompt: "0.00000004",
      completion: "0.00000025",
      input_cache_read: "0.00000001",
    });
    expect(body.data[0].x_billing_window).toBe("flex");
  });

  test("omits pricing when window is missing and no flex row exists", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 1,
        description: null,
        source: null,
        supportedWindows: null,
        researchedAt: new Date(),
        samplingPresets: [],
        prices: [
          {
            completionWindow: "asap",
            inputPerMTok: 1,
            cachedInputPerMTok: null,
            outputPerMTok: 5,
            currency: "USD",
          },
        ],
      },
    ]);

    const res = await handleModels(reqWithWindow("standard"));
    const body: any = await res.json();
    expect(body.data[0].pricing).toBeUndefined();
    expect(body.data[0].x_billing_window).toBeUndefined();
    // The full per-window list is still emitted regardless.
    expect(body.data[0].x_pricing_by_completion_window).toEqual([
      {
        completion_window: "asap",
        input_per_mtok: 1,
        output_per_mtok: 5,
        currency: "USD",
      },
    ]);
  });

  test("invalid x-completion-window header falls back to default window", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: null,
        samplingPresets: [],
        prices: [
          {
            completionWindow: "standard",
            inputPerMTok: 1,
            cachedInputPerMTok: null,
            outputPerMTok: 5,
            currency: "USD",
          },
        ],
      },
    ]);

    const res = await handleModels(reqWithWindow("garbage"));
    const body: any = await res.json();
    // Default DEFAULT_COMPLETION_WINDOW is "standard".
    expect(body.data[0].pricing).toEqual({
      prompt: "0.000001",
      completion: "0.000005",
    });
  });

  test("window prefix filters models by supportedWindows", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [
          { id: "model-a", object: "model", created: 1, owned_by: "x" },
          { id: "model-b", object: "model", created: 2, owned_by: "y" },
          { id: "model-c", object: "model", created: 3, owned_by: "z" },
        ],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "model-a",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: '["asap","flex"]',
        samplingPresets: [],
        prices: [],
      },
      {
        modelId: "model-b",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: '["asap","priority","standard","flex"]',
        samplingPresets: [],
        prices: [],
      },
      // model-c has no supportedWindows (not yet researched)
    ]);

    // /flex/v1/models should include model-a, model-b, and model-c
    const res = await handleModels(reqWithWindow("flex"));
    const body: any = await res.json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids.sort()).toEqual(["model-a", "model-b", "model-c"]);
  });

  test("window prefix excludes incompatible models", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [
          { id: "model-a", object: "model", created: 1, owned_by: "x" },
          { id: "model-b", object: "model", created: 2, owned_by: "y" },
        ],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "model-a",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: '["asap","flex"]',
        samplingPresets: [],
        prices: [],
      },
      {
        modelId: "model-b",
        contextSize: 1,
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: '["asap","priority","standard","flex"]',
        samplingPresets: [],
        prices: [],
      },
    ]);

    // /standard/v1/models should exclude model-a (only asap+flex)
    const res = await handleModels(reqWithWindow("standard"));
    const body: any = await res.json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toEqual(["model-b"]);
  });
});
