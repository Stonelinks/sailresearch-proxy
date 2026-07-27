/**
 * Unit tests for the GraphQL resolvers, replacing the coverage that lived in
 * the old src/routes/dashboard-api.test.ts. We exercise the schema via
 * graphql.execute with a hand-rolled context so the same Prisma/sail/pubsub
 * mocks that backed the REST tests can drive the resolvers directly — no HTTP
 * or WS plumbing involved.
 */
import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";
import { execute, parse } from "graphql";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const mockListModels = mock<() => Promise<{ status: number; data: any }>>();
mock.module("../sail-client.ts", () => ({
  sail: { listModels: mockListModels },
}));

const mockResearchAndUpsertOne = mock<(id: string) => Promise<void>>();
const mockResearchAndUpsertMany =
  mock<(ids: string[]) => Promise<Array<{ modelId: string; error: string }>>>();
mock.module("./research-models-runner.ts", () => ({
  researchAndUpsertOne: mockResearchAndUpsertOne,
  researchAndUpsertMany: mockResearchAndUpsertMany,
}));

const mockModelMetaFindMany = mock();
const mockModelMetaFindUnique = mock();

const mockPrisma = {
  modelMeta: {
    findMany: mockModelMetaFindMany,
    findUnique: mockModelMetaFindUnique,
  },
} as any;

// Import schema + pubsub AFTER the module mocks so the resolvers pick them up.
const { schema } = await import("./schema.ts");
const { pubsub } = await import("./pubsub.ts");

const ctx = { prisma: mockPrisma, pubsub };

async function run(query: string, variableValues?: Record<string, unknown>) {
  return execute({
    schema,
    document: parse(query),
    contextValue: ctx,
    variableValues,
  });
}

describe("Query.models", () => {
  beforeEach(() => {
    mockListModels.mockReset();
    mockModelMetaFindMany.mockReset();
  });

  test("enriches Sail models with ModelMeta + presets", async () => {
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
          {
            id: "model-b",
            object: "model",
            created: 1700000001,
            owned_by: "org-b",
          },
        ],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "model-a",
        contextSize: 131072,
        samplingPresets: [
          {
            name: "default",
            description: "General",
            params: '{"temperature":0.7}',
          },
        ],
        description: "A large language model",
        source: "https://huggingface.co/org-a/model-a",
        supportedWindows: '["asap","priority","standard","flex"]',
        researchedAt: new Date("2025-06-01T00:00:00Z"),
      },
    ]);

    const res = await run(`
      { models {
          id ownedBy contextSize description source researchedAt
          supportedWindows
          samplingPresets { name description params }
        } }
    `);

    expect(res.errors).toBeUndefined();
    const data = (res.data as any).models;
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      id: "model-a",
      ownedBy: "org-a",
      contextSize: 131072,
      description: "A large language model",
      source: "https://huggingface.co/org-a/model-a",
      supportedWindows: ["asap", "priority", "standard", "flex"],
      researchedAt: "2025-06-01T00:00:00.000Z",
      samplingPresets: [
        {
          name: "default",
          description: "General",
          params: { temperature: 0.7 },
        },
      ],
    });
    expect(data[1]).toEqual({
      id: "model-b",
      ownedBy: "org-b",
      contextSize: null,
      description: null,
      source: null,
      supportedWindows: null,
      researchedAt: null,
      samplingPresets: null,
    });
  });

  test("falls back to {} params when sampling preset JSON is malformed", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        object: "list",
        data: [{ id: "m", object: "model", created: 1, owned_by: "x" }],
      },
    });
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m",
        contextSize: 4096,
        samplingPresets: [
          { name: "broken", description: "", params: "{not json" },
        ],
        description: null,
        source: null,
        researchedAt: new Date(),
        supportedWindows: null,
      },
    ]);

    const res = await run(`
      { models { contextSize samplingPresets { name params } } }
    `);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).models[0].samplingPresets).toEqual([
      { name: "broken", params: {} },
    ]);
    expect((res.data as any).models[0].contextSize).toBe(4096);
  });

  test("surfaces a GraphQL error when Sail upstream fails", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 500,
      data: { error: { message: "Internal error" } },
    });

    const res = await run(`{ models { id } }`);
    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/Sail upstream returned 500/);
  });
});

describe("Mutation.refetchModel", () => {
  beforeEach(() => {
    mockListModels.mockReset();
    mockModelMetaFindUnique.mockReset();
    mockResearchAndUpsertOne.mockReset();
  });

  test("invokes the research runner and returns the refreshed Model", async () => {
    mockResearchAndUpsertOne.mockResolvedValueOnce(undefined);
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ id: "m1", object: "model", created: 100, owned_by: "org" }],
      },
    });
    mockModelMetaFindUnique.mockResolvedValueOnce({
      modelId: "m1",
      contextSize: 8192,
      samplingPresets: [],
      description: "fresh",
      source: "https://example.com/m1",
      supportedWindows: '["asap","standard"]',
      researchedAt: new Date("2025-06-02T00:00:00Z"),
    });

    const res = await run(
      `mutation R($id: ID!) { refetchModel(modelId: $id) { id contextSize description researchedAt } }`,
      { id: "m1" },
    );

    expect(res.errors).toBeUndefined();
    expect(mockResearchAndUpsertOne).toHaveBeenCalledWith("m1");
    expect((res.data as any).refetchModel).toEqual({
      id: "m1",
      contextSize: 8192,
      description: "fresh",
      researchedAt: "2025-06-02T00:00:00.000Z",
    });
  });

  test("errors when the model id is unknown to Sail", async () => {
    mockResearchAndUpsertOne.mockResolvedValueOnce(undefined);
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: { data: [] },
    });

    const res = await run(
      `mutation R($id: ID!) { refetchModel(modelId: $id) { id } }`,
      { id: "ghost" },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not found in Sail upstream/);
  });
});

describe("Mutation.researchAllModels", () => {
  beforeEach(() => {
    mockListModels.mockReset();
    mockModelMetaFindMany.mockReset();
    mockResearchAndUpsertMany.mockReset();
  });

  test("researches all models in parallel and returns enriched list", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [
          { id: "m1", object: "model", created: 100, owned_by: "org-a" },
          { id: "m2", object: "model", created: 101, owned_by: "org-b" },
        ],
      },
    });
    mockResearchAndUpsertMany.mockResolvedValueOnce([]); // no errors
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m1",
        contextSize: 8192,
        samplingPresets: [],
        description: "researched",
        source: "https://example.com/m1",
        supportedWindows: '["asap","standard"]',
        researchedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        modelId: "m2",
        contextSize: 4096,
        samplingPresets: [],
        description: "also researched",
        source: null,
        supportedWindows: null,
        researchedAt: new Date("2025-06-02T00:01:00Z"),
      },
    ]);

    const res = await run(`
      mutation { researchAllModels { id contextSize description researchedAt } }
    `);

    expect(res.errors).toBeUndefined();
    expect(mockResearchAndUpsertMany).toHaveBeenCalledTimes(1);
    expect(mockResearchAndUpsertMany).toHaveBeenCalledWith(["m1", "m2"], {
      pruneStale: true,
    });
    const models = (res.data as any).researchAllModels;
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: "m1",
      contextSize: 8192,
      description: "researched",
      researchedAt: "2025-06-02T00:00:00.000Z",
    });
    expect(models[1]).toEqual({
      id: "m2",
      contextSize: 4096,
      description: "also researched",
      researchedAt: "2025-06-02T00:01:00.000Z",
    });
  });

  test("returns all models even when some fail research", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [
          { id: "m1", object: "model", created: 100, owned_by: "org-a" },
          { id: "m2", object: "model", created: 101, owned_by: "org-b" },
          { id: "m3", object: "model", created: 102, owned_by: "org-c" },
        ],
      },
    });
    // Simulate partial failure: m2 failed
    mockResearchAndUpsertMany.mockResolvedValueOnce([
      { modelId: "m2", error: "pi SDK timeout" },
    ]);
    mockModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "m1",
        contextSize: 8192,
        samplingPresets: [],
        description: "ok",
        source: null,
        supportedWindows: '["asap","standard"]',
        researchedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        modelId: "m3",
        contextSize: 2048,
        samplingPresets: [],
        description: "ok too",
        source: null,
        supportedWindows: null,
        researchedAt: new Date("2025-06-02T00:02:00Z"),
      },
    ]);

    const res = await run(`
      mutation { researchAllModels { id contextSize } }
    `);

    // Should still succeed — partial failure is not a GraphQL error
    expect(res.errors).toBeUndefined();
    const models = (res.data as any).researchAllModels;
    expect(models).toHaveLength(3); // All models returned, m2 just not researched
  });

  test("returns GraphQL error when Sail upstream fails", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 500,
      data: { error: { message: "Internal error" } },
    });

    const res = await run(`
      mutation { researchAllModels { id } }
    `);

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/Sail upstream returned 500/);
    expect(mockResearchAndUpsertMany).not.toHaveBeenCalled();
  });
});
