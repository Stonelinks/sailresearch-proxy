import { builder } from "./builder.ts";
import {
  JOB_SUMMARY_SELECT,
  JOB_DETAIL_SELECT,
  jobToSummary,
  jobToDetail,
} from "../services/job-shapes.ts";
import { sail } from "../sail-client.ts";
import {
  researchAndUpsertOne,
  researchAndUpsertMany,
} from "./research-models-runner.ts";
import { mergeModelMeta, type SailUpstreamModel } from "../models-meta.ts";
import type { JobStatus } from "../types.ts";
import { log } from "../../shared/logger.ts";
import {
  researchTracker,
  type ModelResearchUpdatePayload,
  type BatchProgressWire,
} from "./research-tracker.ts";

const JOB_STATUS_VALUES = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];

const JobStatusEnum = builder.enumType("JobStatus", {
  values: JOB_STATUS_VALUES,
});

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

builder.objectType("Job", {
  fields: (t) => ({
    id: t.exposeID("id"),
    sailResponseId: t.exposeString("sailResponseId"),
    status: t.field({ type: JobStatusEnum, resolve: (j) => j.status }),
    model: t.exposeString("model"),
    completionWindow: t.exposeString("completionWindow"),
    apiType: t.exposeString("apiType"),
    createdAt: t.field({ type: "DateTime", resolve: (j) => j.createdAt }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (j) => j.completedAt,
    }),
    durationMs: t.exposeInt("durationMs", { nullable: true }),
    pollCount: t.int({ resolve: (j) => Number(j.pollCount) }),
    hasError: t.exposeBoolean("hasError"),
  }),
});

builder.objectType("JobDetail", {
  fields: (t) => ({
    id: t.exposeID("id"),
    sailResponseId: t.exposeString("sailResponseId"),
    status: t.field({ type: JobStatusEnum, resolve: (j) => j.status }),
    model: t.exposeString("model"),
    completionWindow: t.exposeString("completionWindow"),
    apiType: t.exposeString("apiType"),
    createdAt: t.field({ type: "DateTime", resolve: (j) => j.createdAt }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (j) => j.completedAt,
    }),
    durationMs: t.exposeInt("durationMs", { nullable: true }),
    pollCount: t.int({ resolve: (j) => Number(j.pollCount) }),
    hasError: t.exposeBoolean("hasError"),
    requestBody: t.exposeString("requestBody", { nullable: true }),
    responseBody: t.exposeString("responseBody", { nullable: true }),
    errorBody: t.exposeString("errorBody", { nullable: true }),
  }),
});

const JobsResult = builder
  .objectRef<{
    jobs: ReturnType<typeof jobToSummary>[];
    total: number;
    limit: number;
    offset: number;
  }>("JobsResult")
  .implement({
    fields: (t) => ({
      jobs: t.field({ type: ["Job"], resolve: (r) => r.jobs }),
      total: t.exposeInt("total"),
      limit: t.exposeInt("limit"),
      offset: t.exposeInt("offset"),
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
    jobs: t.field({
      type: JobsResult,
      args: {
        limit: t.arg.int({ defaultValue: 50 }),
        offset: t.arg.int({ defaultValue: 0 }),
        status: t.arg({ type: JobStatusEnum, required: false }),
      },
      resolve: async (_root, args, ctx) => {
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const offset = Math.max(args.offset ?? 0, 0);
        const where = args.status ? { status: args.status } : {};
        const [jobs, total] = await Promise.all([
          ctx.prisma.pendingJob.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
            select: JOB_SUMMARY_SELECT,
          }),
          ctx.prisma.pendingJob.count({ where }),
        ]);
        return { jobs: jobs.map(jobToSummary), total, limit, offset };
      },
    }),

    job: t.field({
      type: "JobDetail",
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_root, { id }, ctx) => {
        const row = await ctx.prisma.pendingJob.findUnique({
          where: { id: String(id) },
          select: JOB_DETAIL_SELECT,
        });
        return row ? jobToDetail(row) : null;
      },
    }),

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

        // Research all models in parallel (scrapes docs once, shares results)
        const errors = await researchAndUpsertMany(modelIds);

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
    jobUpdated: t.field({
      type: "Job",
      args: { id: t.arg.id({ required: false }) },
      subscribe: async function* (_root, args, ctx) {
        const wantedId = args.id ? String(args.id) : null;
        for await (const job of ctx.pubsub.subscribe("jobUpdated")) {
          if (wantedId && job.id !== wantedId) continue;
          yield job;
        }
      },
      resolve: (payload) => payload,
    }),

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
