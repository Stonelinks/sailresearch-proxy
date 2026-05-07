/**
 * Unit tests for the GraphQL resolvers, replacing the coverage that lived in
 * the old src/routes/dashboard-api.test.ts. We exercise the schema via
 * graphql.execute with a hand-rolled context so the same Prisma/sail/pubsub
 * mocks that backed the REST tests can drive the resolvers directly — no HTTP
 * or WS plumbing involved.
 */
import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";
import { execute, parse, subscribe } from "graphql";

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

const mockPendingJobFindMany = mock();
const mockPendingJobCount = mock();
const mockPendingJobFindUnique = mock();
const mockModelMetaFindMany = mock();
const mockModelMetaFindUnique = mock();

const mockPrisma = {
  pendingJob: {
    findMany: mockPendingJobFindMany,
    count: mockPendingJobCount,
    findUnique: mockPendingJobFindUnique,
  },
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

describe("Query.jobs", () => {
  beforeEach(() => {
    mockPendingJobFindMany.mockReset();
    mockPendingJobCount.mockReset();
  });

  test("returns paginated list with hasError + durationMs", async () => {
    mockPendingJobFindMany.mockResolvedValueOnce([
      {
        id: "job1",
        sailResponseId: "resp1",
        status: "completed",
        model: "test-model",
        completionWindow: "standard",
        apiType: "chat-completions",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        completedAt: new Date("2025-01-01T00:01:00Z"),
        pollCount: 5,
        errorBody: null,
      },
    ]);
    mockPendingJobCount.mockResolvedValueOnce(1);

    const res = await run(`
      { jobs(limit: 50, offset: 0) {
          total limit offset
          jobs { id status hasError durationMs }
        } }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data?.jobs).toEqual({
      total: 1,
      limit: 50,
      offset: 0,
      jobs: [
        {
          id: "job1",
          status: "completed",
          hasError: false,
          durationMs: 60_000,
        },
      ],
    });
  });

  test("filters by status", async () => {
    mockPendingJobFindMany.mockResolvedValueOnce([]);
    mockPendingJobCount.mockResolvedValueOnce(0);

    await run(`{ jobs(status: failed) { total } }`);

    expect(mockPendingJobFindMany).toHaveBeenCalledTimes(1);
    expect(mockPendingJobFindMany.mock.calls[0]![0].where).toEqual({
      status: "failed",
    });
  });

  test("clamps limit to 1–200", async () => {
    mockPendingJobFindMany.mockResolvedValueOnce([]);
    mockPendingJobCount.mockResolvedValueOnce(0);

    await run(`{ jobs(limit: 999) { total } }`);

    expect(mockPendingJobFindMany.mock.calls[0]![0].take).toBe(200);
  });

  test("maps in_progress status to running", async () => {
    mockPendingJobFindMany.mockResolvedValueOnce([
      {
        id: "job-ip",
        sailResponseId: "resp-ip",
        status: "in_progress",
        model: "test-model",
        completionWindow: "flex",
        apiType: "responses",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        completedAt: null,
        pollCount: 2,
        errorBody: null,
      },
    ]);
    mockPendingJobCount.mockResolvedValueOnce(1);

    const res = await run(`
      { jobs { jobs { id status } } }
    `);

    expect(res.errors).toBeUndefined();
    expect((res.data?.jobs as any).jobs[0].status).toBe("running");
  });

  test("maps in_progress status to running on job detail", async () => {
    mockPendingJobFindUnique.mockResolvedValueOnce({
      id: "job-ip",
      sailResponseId: "resp-ip",
      status: "in_progress",
      model: "test-model",
      completionWindow: "flex",
      apiType: "responses",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      completedAt: null,
      pollCount: 2,
      errorBody: null,
      requestBody: null,
      responseBody: null,
    });

    const res = await run(`query Q($id: ID!) { job(id: $id) { id status } }`, {
      id: "job-ip",
    });

    expect(res.errors).toBeUndefined();
    expect((res.data as any)?.job?.status).toBe("running");
  });

  test("marks hasError true when errorBody is not null", async () => {
    mockPendingJobFindMany.mockResolvedValueOnce([
      {
        id: "job2",
        sailResponseId: "resp2",
        status: "failed",
        model: "test-model",
        completionWindow: "flex",
        apiType: "responses",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        completedAt: new Date("2025-01-01T00:02:00Z"),
        pollCount: 10,
        errorBody: '{"error":{"message":"timeout"}}',
      },
    ]);
    mockPendingJobCount.mockResolvedValueOnce(1);

    const res = await run(`{ jobs { jobs { hasError } } }`);
    expect((res.data?.jobs as any).jobs[0].hasError).toBe(true);
  });
});

describe("Query.job", () => {
  beforeEach(() => {
    mockPendingJobFindUnique.mockReset();
  });

  test("returns detail with request/response/error bodies", async () => {
    mockPendingJobFindUnique.mockResolvedValueOnce({
      id: "job1",
      sailResponseId: "resp1",
      status: "completed",
      model: "test-model",
      completionWindow: "standard",
      apiType: "chat-completions",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      completedAt: new Date("2025-01-01T00:01:00Z"),
      pollCount: 5,
      errorBody: null,
      requestBody: '{"model":"test-model","messages":[]}',
      responseBody: '{"id":"resp1","output":[]}',
    });

    const res = await run(
      `
      query Q($id: ID!) {
        job(id: $id) { id requestBody responseBody errorBody }
      }
    `,
      { id: "job1" },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.job).toEqual({
      id: "job1",
      requestBody: '{"model":"test-model","messages":[]}',
      responseBody: '{"id":"resp1","output":[]}',
      errorBody: null,
    });
  });

  test("returns null for unknown id", async () => {
    mockPendingJobFindUnique.mockResolvedValueOnce(null);

    const res = await run(`query Q($id: ID!) { job(id: $id) { id } }`, {
      id: "nonexistent",
    });

    expect(res.errors).toBeUndefined();
    expect(res.data?.job).toBeNull();
  });
});

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
        researchedAt: new Date("2025-06-01T00:00:00Z"),
      },
    ]);

    const res = await run(`
      { models {
          id ownedBy contextSize description source researchedAt
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
        researchedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        modelId: "m2",
        contextSize: 4096,
        samplingPresets: [],
        description: "also researched",
        source: null,
        researchedAt: new Date("2025-06-02T00:01:00Z"),
      },
    ]);

    const res = await run(`
      mutation { researchAllModels { id contextSize description researchedAt } }
    `);

    expect(res.errors).toBeUndefined();
    expect(mockResearchAndUpsertMany).toHaveBeenCalledTimes(1);
    expect(mockResearchAndUpsertMany).toHaveBeenCalledWith(["m1", "m2"]);
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
        researchedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        modelId: "m3",
        contextSize: 2048,
        samplingPresets: [],
        description: "ok too",
        source: null,
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

describe("Subscription.jobUpdated", () => {
  test("delivers payloads published to pubsub, filtered by id", async () => {
    const result = await subscribe({
      schema,
      document: parse(`subscription S($id: ID) {
        jobUpdated(id: $id) { id status }
      }`),
      contextValue: ctx,
      variableValues: { id: "want" },
    });

    if (!("next" in (result as any))) {
      throw new Error("expected an async iterator from subscribe()");
    }
    const iter = result as AsyncIterableIterator<any>;

    // Poke the iterator to register the handler before publishing.
    const first = iter.next();
    // Yield to the subscribe() machinery so its addEventListener runs.
    await new Promise((r) => setTimeout(r, 0));

    pubsub.publish("jobUpdated", {
      id: "skip",
      status: "queued",
    } as any);
    pubsub.publish("jobUpdated", {
      id: "want",
      status: "completed",
    } as any);

    const payload = await first;
    expect(payload.value.data.jobUpdated).toEqual({
      id: "want",
      status: "completed",
    });

    await iter.return?.();
  });
});
