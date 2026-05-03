import { describe, test, expect, mock, beforeEach, beforeAll } from "bun:test";

// Set required env vars before any imports that use config
beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

// Mock the sail client
const mockListModels = mock<() => Promise<{ status: number; data: any }>>();

mock.module("../sail-client.ts", () => ({
  sail: {
    listModels: mockListModels,
  },
}));

// Mock prisma
const mockPrismaPendingJobFindMany = mock();
const mockPrismaPendingJobCount = mock();
const mockPrismaPendingJobFindUnique = mock();
const mockPrismaModelMetaFindMany = mock();

mock.module("../db.ts", () => ({
  prisma: {
    pendingJob: {
      findMany: mockPrismaPendingJobFindMany,
      count: mockPrismaPendingJobCount,
      findUnique: mockPrismaPendingJobFindUnique,
    },
    modelMeta: {
      findMany: mockPrismaModelMetaFindMany,
    },
  },
}));

const {
  handleDashboardJobs,
  handleDashboardJobDetail,
  handleDashboardModels,
  broadcastJobUpdate,
  registerDashboardClient,
  unregisterDashboardClient,
} = await import("../routes/dashboard-api.ts");

describe("handleDashboardJobs", () => {
  beforeEach(() => {
    mockPrismaPendingJobFindMany.mockReset();
    mockPrismaPendingJobCount.mockReset();
  });

  test("returns jobs list with pagination", async () => {
    mockPrismaPendingJobFindMany.mockResolvedValueOnce([
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
    mockPrismaPendingJobCount.mockResolvedValueOnce(1);

    const req = new Request(
      "http://localhost/api/dashboard/jobs?limit=50&offset=0",
    );
    const res = await handleDashboardJobs(req);

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.jobs[0].id).toBe("job1");
    expect(body.jobs[0].status).toBe("completed");
    expect(body.jobs[0].hasError).toBe(false);
    expect(body.jobs[0].durationMs).toBe(60_000);
  });

  test("filters by status", async () => {
    mockPrismaPendingJobFindMany.mockResolvedValueOnce([]);
    mockPrismaPendingJobCount.mockResolvedValueOnce(0);

    const req = new Request(
      "http://localhost/api/dashboard/jobs?status=failed",
    );
    await handleDashboardJobs(req);

    expect(mockPrismaPendingJobFindMany).toHaveBeenCalledTimes(1);
    const call = mockPrismaPendingJobFindMany.mock.calls[0]![0];
    expect(call.where).toEqual({ status: "failed" });
  });

  test("clamps limit to 1–200", async () => {
    mockPrismaPendingJobFindMany.mockResolvedValueOnce([]);
    mockPrismaPendingJobCount.mockResolvedValueOnce(0);

    const req = new Request("http://localhost/api/dashboard/jobs?limit=999");
    await handleDashboardJobs(req);

    const call = mockPrismaPendingJobFindMany.mock.calls[0]![0];
    expect(call.take).toBe(200);
  });

  test("marks hasError true when errorBody is not null", async () => {
    mockPrismaPendingJobFindMany.mockResolvedValueOnce([
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
    mockPrismaPendingJobCount.mockResolvedValueOnce(1);

    const req = new Request("http://localhost/api/dashboard/jobs");
    const res = await handleDashboardJobs(req);
    const body: any = await res.json();

    expect(body.jobs[0].hasError).toBe(true);
  });
});

describe("handleDashboardJobDetail", () => {
  beforeEach(() => {
    mockPrismaPendingJobFindUnique.mockReset();
  });

  test("returns job detail with request/response/error bodies", async () => {
    mockPrismaPendingJobFindUnique.mockResolvedValueOnce({
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

    const req = new Request("http://localhost/api/dashboard/jobs/job1");
    const res = await handleDashboardJobDetail(req);

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.requestBody).toBe('{"model":"test-model","messages":[]}');
    expect(body.responseBody).toBe('{"id":"resp1","output":[]}');
    expect(body.errorBody).toBeNull();
  });

  test("returns 404 for unknown job id", async () => {
    mockPrismaPendingJobFindUnique.mockResolvedValueOnce(null);

    const req = new Request("http://localhost/api/dashboard/jobs/nonexistent");
    const res = await handleDashboardJobDetail(req);

    expect(res.status).toBe(404);
  });

  test("returns 404 for bare /jobs path without id", async () => {
    const req = new Request("http://localhost/api/dashboard/jobs/jobs");
    const res = await handleDashboardJobDetail(req);

    expect(res.status).toBe(404);
  });
});

describe("handleDashboardModels", () => {
  beforeEach(() => {
    mockListModels.mockReset();
    mockPrismaModelMetaFindMany.mockReset();
  });

  test("proxies Sail models list with metadata enrichment", async () => {
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

    mockPrismaModelMetaFindMany.mockResolvedValueOnce([
      {
        modelId: "model-a",
        contextSize: 131072,
        samplingPresets:
          '[{"name":"default","description":"General purpose","params":{"temperature":0.7}}]',
        description: "A large language model",
        source: "https://huggingface.co/org-a/model-a",
        researchedAt: new Date("2025-06-01T00:00:00Z"),
      },
    ]);

    const res = await handleDashboardModels();

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toHaveLength(2);

    // model-a has metadata
    expect(body.data[0].id).toBe("model-a");
    expect(body.data[0].contextSize).toBe(131072);
    expect(body.data[0].samplingPresets).toEqual([
      {
        name: "default",
        description: "General purpose",
        params: { temperature: 0.7 },
      },
    ]);
    expect(body.data[0].description).toBe("A large language model");
    expect(body.data[0].source).toBe("https://huggingface.co/org-a/model-a");
    expect(body.data[0].researchedAt).toBe("2025-06-01T00:00:00.000Z");

    // model-b has no metadata
    expect(body.data[1].id).toBe("model-b");
    expect(body.data[1].contextSize).toBeNull();
    expect(body.data[1].samplingPresets).toBeNull();
    expect(body.data[1].description).toBeNull();
    expect(body.data[1].source).toBeNull();
    expect(body.data[1].researchedAt).toBeNull();
  });

  test("returns models with null metadata when no ModelMeta rows exist", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 200,
      data: {
        object: "list",
        data: [
          {
            id: "model-x",
            object: "model",
            created: 1700000000,
            owned_by: "org-x",
          },
        ],
      },
    });

    mockPrismaModelMetaFindMany.mockResolvedValueOnce([]);

    const res = await handleDashboardModels();
    const body: any = await res.json();

    expect(body.data[0].contextSize).toBeNull();
    expect(body.data[0].samplingPresets).toBeNull();
    expect(body.data[0].description).toBeNull();
  });

  test("maps Sail errors", async () => {
    mockListModels.mockResolvedValueOnce({
      status: 500,
      data: {
        error: { message: "Internal error", type: "server_error" },
      },
    });

    const res = await handleDashboardModels();
    expect(res.status).toBe(502);
  });
});

describe("broadcastJobUpdate / WebSocket", () => {
  test("broadcastJobUpdate sends messages to registered clients", () => {
    // Create a mock ServerWebSocket
    const sentMessages: string[] = [];
    const mockWs = {
      send: (msg: string) => {
        sentMessages.push(msg);
      },
      data: { subscribedAt: Date.now() },
    } as any;

    registerDashboardClient(mockWs);

    broadcastJobUpdate({
      id: "job-ws-1",
      sailResponseId: "resp-ws-1",
      status: "completed",
      model: "test-model",
      completionWindow: "standard",
      apiType: "chat-completions",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      pollCount: 3,
      hasError: false,
    });

    expect(sentMessages.length).toBeGreaterThanOrEqual(2); // connected + job_update
    const updateMsg = sentMessages.find((m) => m.includes("job_update"));
    expect(updateMsg).toBeDefined();
    const parsed = JSON.parse(updateMsg!);
    expect(parsed.type).toBe("job_update");
    expect(parsed.data.id).toBe("job-ws-1");

    unregisterDashboardClient(mockWs);
  });

  test("registerDashboardClient sends connected event", () => {
    const sentMessages: string[] = [];
    const mockWs = {
      send: (msg: string) => {
        sentMessages.push(msg);
      },
      data: { subscribedAt: Date.now() },
    } as any;

    registerDashboardClient(mockWs);

    expect(sentMessages.length).toBe(1);
    const parsed = JSON.parse(sentMessages[0]!);
    expect(parsed.type).toBe("connected");

    unregisterDashboardClient(mockWs);
  });

  test("unregisterDashboardClient removes client so it no longer receives updates", () => {
    const sentMessages: string[] = [];
    const mockWs = {
      send: (msg: string) => {
        sentMessages.push(msg);
      },
      data: { subscribedAt: Date.now() },
    } as any;

    registerDashboardClient(mockWs);
    unregisterDashboardClient(mockWs);

    sentMessages.length = 0;

    broadcastJobUpdate({
      id: "job-ws-2",
      sailResponseId: "resp-ws-2",
      status: "failed",
      model: "test-model",
      completionWindow: "flex",
      apiType: "responses",
      createdAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
      pollCount: 1,
      hasError: true,
    });

    // Should not receive the update
    expect(sentMessages).toHaveLength(0);
  });
});
