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
      },
    ]);

    const res = await handleModels();
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
    expect(m.supported_parameters).toEqual([
      "temperature",
      "top_k",
      "top_p",
    ]);
    // Namespaced extension carries the full preset list.
    expect(m.x_sampling_presets).toHaveLength(2);
    expect(m.x_sampling_presets[0]).toEqual({
      name: "default",
      description: "General",
      params: { temperature: 0.7, top_p: 0.95 },
    });
    expect(m.x_source).toBe("https://hf.co/org-a/model-a");
    expect(m.x_researched_at).toBe("2025-06-01T00:00:00.000Z");
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

    const res = await handleModels();
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
        samplingPresets: [
          { name: "creative", description: "", params: '{"temperature":1.2}' },
          {
            name: "deterministic",
            description: "",
            params: '{"temperature":0}',
          },
        ],
      },
    ]);

    const res = await handleModels();
    const body: any = await res.json();
    expect(body.data[0].default_parameters).toEqual({ temperature: 1.2 });
  });

  test("propagates upstream error via mapSailError", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 503,
      data: { error: { message: "upstream down" } },
    });

    const res = await handleModels();
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
        samplingPresets: [
          { name: "broken", description: "", params: "{not json" },
        ],
      },
    ]);

    const res = await handleModels();
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data[0].default_parameters).toEqual({});
    expect(body.data[0].supported_parameters).toEqual([]);
  });
});
