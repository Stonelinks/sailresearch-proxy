import { builder } from "./builder.ts";
import {
  JOB_SUMMARY_SELECT,
  JOB_DETAIL_SELECT,
  jobToSummary,
  jobToDetail,
} from "../services/job-shapes.ts";
import { sail } from "../sail-client.ts";
import { researchAndUpsertOne } from "./research-models-runner.ts";
import type { ModelWire, PresetWire } from "./builder.ts";
import type { JobStatus } from "../types.ts";

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

builder.objectType("Model", {
  fields: (t) => ({
    id: t.exposeID("id"),
    object: t.exposeString("object"),
    created: t.exposeInt("created"),
    ownedBy: t.exposeString("ownedBy"),
    contextSize: t.exposeInt("contextSize", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    source: t.exposeString("source", { nullable: true }),
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
    pollCount: t.exposeInt("pollCount"),
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
    pollCount: t.exposeInt("pollCount"),
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

// A malformed params JSON string would crash the entire `models` query. Treat
// any parse failure as "no presets" and keep going. Mirrors the equivalent
// helper that lived in dashboard-api.ts.
function parseSamplingParams(p: {
  name: string;
  description: string;
  params: string;
}): PresetWire {
  try {
    const parsed = JSON.parse(p.params);
    return {
      name: p.name,
      description: p.description,
      params:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, number | string | boolean>)
          : {},
    };
  } catch {
    return { name: p.name, description: p.description, params: {} };
  }
}

async function loadModelWire(
  modelId: string,
  ctx: { prisma: any },
): Promise<ModelWire | null> {
  const sailRes = await sail.listModels();
  if (sailRes.status !== 200) return null;
  const list = (sailRes.data?.data ?? []) as Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
  const sailModel = list.find((m) => m.id === modelId);
  if (!sailModel) return null;
  const meta = await ctx.prisma.modelMeta.findUnique({
    where: { modelId },
    include: { samplingPresets: true },
  });
  return {
    id: sailModel.id,
    object: sailModel.object,
    created: sailModel.created,
    ownedBy: sailModel.owned_by,
    contextSize: meta?.contextSize ?? null,
    samplingPresets: meta
      ? meta.samplingPresets.map(parseSamplingParams)
      : null,
    description: meta?.description ?? null,
    source: meta?.source ?? null,
    researchedAt: meta?.researchedAt?.toISOString() ?? null,
  };
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

    models: t.field({
      type: ["Model"],
      resolve: async (_root, _args, ctx) => {
        const sailRes = await sail.listModels();
        if (sailRes.status !== 200) {
          throw new Error(
            `Sail upstream returned ${sailRes.status} for /v1/models`,
          );
        }
        const list = (sailRes.data?.data ?? []) as Array<{
          id: string;
          object: string;
          created: number;
          owned_by: string;
        }>;
        const metas = await ctx.prisma.modelMeta.findMany({
          include: { samplingPresets: true },
        });
        const byId = new Map(metas.map((m) => [m.modelId, m]));
        return list.map((m): ModelWire => {
          const meta = byId.get(m.id);
          return {
            id: m.id,
            object: m.object,
            created: m.created,
            ownedBy: m.owned_by,
            contextSize: meta?.contextSize ?? null,
            samplingPresets: meta
              ? meta.samplingPresets.map(parseSamplingParams)
              : null,
            description: meta?.description ?? null,
            source: meta?.source ?? null,
            researchedAt: meta?.researchedAt?.toISOString() ?? null,
          };
        });
      },
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
  }),
});

export const schema = builder.toSchema();
