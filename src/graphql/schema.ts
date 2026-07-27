import { builder } from "./builder.ts";
import { sail } from "../sail-client.ts";
import {
  researchAndUpsertOne,
  researchAndUpsertMany,
} from "./research-models-runner.ts";
import { mergeModelMeta, type SailUpstreamModel } from "../models-meta.ts";
import { log } from "../../shared/logger.ts";
import {
  researchTracker,
  type ModelResearchUpdatePayload,
  type BatchProgressWire,
} from "./research-tracker.ts";

const ResearchUpdateStatusEnum = builder.enumType("ResearchUpdateStatus", {
  values: ["started", "completed", "failed"] as const,
});

const BatchProgressRef = builder
  .objectRef<BatchProgressWire>("BatchProgress")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      total: t.exposeInt("total"),
      completed: t.exposeInt("completed"),
      errors: t.exposeInt("errors"),
    }),
  });

builder.objectType("ModelResearchUpdate", {
  fields: (t) => ({
    modelId: t.exposeString("modelId"),
    status: t.field({
      type: ResearchUpdateStatusEnum,
      resolve: (u) => u.status,
    }),
    error: t.exposeString("error", { nullable: true }),
    batch: t.field({
      type: BatchProgressRef,
      nullable: true,
      resolve: (u) => u.batch,
    }),
  }),
});

builder.objectType("ActiveResearch", {
  fields: (t) => ({
    modelIds: t.field({
      type: ["String"],
      resolve: (r) => r.modelIds,
    }),
    batch: t.field({
      type: BatchProgressRef,
      nullable: true,
      resolve: (r) => r.batch,
    }),
  }),
});

builder.objectType("SamplingPreset", {
  fields: (t) => ({
    name: t.exposeString("name"),
    description: t.exposeString("description"),
    params: t.field({
      type: "JSON",
      resolve: (preset) => preset.params,
    }),
  }),
});

builder.objectType("ModelPrice", {
  fields: (t) => ({
    completionWindow: t.exposeString("completionWindow"),
    inputPerMTok: t.exposeFloat("inputPerMTok"),
    cachedInputPerMTok: t.exposeFloat("cachedInputPerMTok", { nullable: true }),
    outputPerMTok: t.exposeFloat("outputPerMTok"),
    currency: t.exposeString("currency"),
  }),
});

builder.objectType("Model", {
  fields: (t) => ({
    id: t.exposeID("id"),
    object: t.exposeString("object"),
    created: t.exposeInt("created"),
    ownedBy: t.exposeString("ownedBy"),
    contextSize: t.exposeInt("contextSize", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    source: t.exposeString("source", { nullable: true }),
    supportsImage: t.exposeBoolean("supportsImage"),
    reasoning: t.exposeBoolean("reasoning"),
    thinkingLevelMap: t.field({
      type: "JSON",
      nullable: true,
      resolve: (m) =>
        m.thinkingLevelMap as Record<string, string | number | boolean> | null,
    }),
    supportedWindows: t.field({
      type: ["String"],
      nullable: true,
      resolve: (m) => m.supportedWindows,
    }),
    researchedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (m) => m.researchedAt,
    }),
    samplingPresets: t.field({
      type: ["SamplingPreset"],
      nullable: true,
      resolve: (m) => m.samplingPresets,
    }),
    prices: t.field({
      type: ["ModelPrice"],
      nullable: true,
      resolve: (m) => m.prices,
    }),
  }),
});

async function loadModelWire(modelId: string, ctx: { prisma: any }) {
  const sailRes = await sail.listModels();
  if (sailRes.status !== 200) return null;
  const list = (sailRes.data?.data ?? []) as SailUpstreamModel[];
  const sailModel = list.find((m) => m.id === modelId);
  if (!sailModel) return null;
  const meta = await ctx.prisma.modelMeta.findUnique({
    where: { modelId },
    include: { samplingPresets: true, prices: true },
  });
  return mergeModelMeta(sailModel, meta ?? undefined);
}

builder.queryType({
  fields: (t) => ({
    model: t.field({
      type: "Model",
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_root, { id }, ctx) => {
        return loadModelWire(String(id), ctx);
      },
    }),

    models: t.field({
      type: ["Model"],
      resolve: async (_root, _args, ctx) => {
        const sailRes = await sail.listModels();
        if (sailRes.status !== 200) {
          throw new Error(
            `Sail upstream returned ${sailRes.status} for /v1/models`,
          );
        }
        const list = (sailRes.data?.data ?? []) as SailUpstreamModel[];
        const metas = await ctx.prisma.modelMeta.findMany({
          include: { samplingPresets: true, prices: true },
        });
        const byId = new Map(metas.map((m) => [m.modelId, m]));
        return list.map((m) => mergeModelMeta(m, byId.get(m.id) ?? undefined));
      },
    }),

    activeResearch: t.field({
      type: "ActiveResearch",
      resolve: () => ({
        modelIds: researchTracker.getActiveModelIds(),
        batch: researchTracker.getBatch(),
      }),
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    refetchModel: t.field({
      type: "Model",
      args: { modelId: t.arg.id({ required: true }) },
      resolve: async (_root, { modelId }, ctx) => {
        const id = String(modelId);
        await researchAndUpsertOne(id);
        const wire = await loadModelWire(id, ctx);
        if (!wire) {
          throw new Error(`Model ${id} not found in Sail upstream`);
        }
        return wire;
      },
    }),

    researchAllModels: t.field({
      type: ["Model"],
      resolve: async (_root, _args, ctx) => {
        // Fetch model list from Sail upstream
        const sailRes = await sail.listModels();
        if (sailRes.status !== 200) {
          throw new Error(
            `Sail upstream returned ${sailRes.status} for /v1/models`,
          );
        }
        const list = (sailRes.data?.data ?? []) as SailUpstreamModel[];
        const modelIds = list.map((m) => m.id);

        // Research all models in parallel (scrapes docs once, shares results).
        // This is the full Sail list, so stale ModelMeta rows are pruned.
        const errors = await researchAndUpsertMany(modelIds, {
          pruneStale: true,
        });

        if (errors.length > 0) {
          log.warn(
            `[researchAllModels] ${errors.length}/${list.length} models failed: ${errors.map((e) => e.modelId).join(", ")}`,
          );
        }

        // Return the full enriched model list
        const metas = await ctx.prisma.modelMeta.findMany({
          include: { samplingPresets: true, prices: true },
        });
        const byId = new Map(metas.map((m) => [m.modelId, m]));
        return list.map((m) => mergeModelMeta(m, byId.get(m.id) ?? undefined));
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    modelResearchUpdated: t.field({
      type: "ModelResearchUpdate",
      subscribe: async function* (_root, _args, ctx) {
        for await (const update of ctx.pubsub.subscribe(
          "modelResearchUpdated",
        )) {
          yield update;
        }
      },
      resolve: (payload: ModelResearchUpdatePayload) => payload,
    }),
  }),
});

export const schema = builder.toSchema();
