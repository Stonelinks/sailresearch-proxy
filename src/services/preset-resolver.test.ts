import { describe, test, expect, mock, beforeAll } from "bun:test";

beforeAll(() => {
  if (!process.env.SAIL_API_KEY) {
    process.env.SAIL_API_KEY = "test-key";
  }
});

const mockFindUnique = mock();
mock.module("../db.ts", () => ({
  prisma: {
    modelMeta: { findUnique: mockFindUnique },
  },
}));

const { resolvePresetModel } = await import("./preset-resolver.ts");

describe("resolvePresetModel", () => {
  test("passes plain model ids through untouched without a DB hit", async () => {
    mockFindUnique.mockClear();
    const body = { model: "org/model", temperature: 0.5 };
    const out = await resolvePresetModel(body);
    expect(out).toBe(body);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("strips the suffix and merges preset params", async () => {
    mockFindUnique.mockResolvedValueOnce({
      modelId: "org/model",
      samplingPresets: [
        { name: "thinking", params: '{"temperature":1,"top_p":0.95}' },
      ],
    });
    const out = await resolvePresetModel({
      model: "org/model::thinking",
      messages: [],
    });
    expect(out.model).toBe("org/model");
    expect(out.temperature).toBe(1);
    expect(out.top_p).toBe(0.95);
  });

  test("client-specified params win over preset params", async () => {
    mockFindUnique.mockResolvedValueOnce({
      modelId: "org/model",
      samplingPresets: [
        { name: "thinking", params: '{"temperature":1,"top_p":0.95}' },
      ],
    });
    const out = await resolvePresetModel({
      model: "org/model::thinking",
      temperature: 0.2,
    });
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.95);
  });

  test("unknown preset still forwards the base model id", async () => {
    mockFindUnique.mockResolvedValueOnce({
      modelId: "org/model",
      samplingPresets: [],
    });
    const out = await resolvePresetModel({ model: "org/model::ghost" });
    expect(out.model).toBe("org/model");
  });

  test("DB failure still forwards the base model id", async () => {
    mockFindUnique.mockRejectedValueOnce(new Error("db locked"));
    const out = await resolvePresetModel({ model: "org/model::thinking" });
    expect(out.model).toBe("org/model");
  });
});
