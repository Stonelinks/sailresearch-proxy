import { prisma } from "../db.ts";
import { openAIError, mapSailError } from "../errors.ts";
import { log } from "../../shared/logger.ts";
import { sail } from "../sail-client.ts";
import type { ServerWebSocket } from "bun";

/** Data attached to each dashboard WebSocket connection. */
export type WSDashboardData = {
  subscribedAt: number;
};

/** The set of connected dashboard WebSocket clients. */
const dashboardClients = new Set<ServerWebSocket<WSDashboardData>>();

/** Broadcast a job update to all connected WebSocket clients. */
export function broadcastJobUpdate(job: {
  id: string;
  sailResponseId: string;
  status: string;
  model: string;
  completionWindow: string;
  apiType: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  pollCount: number;
  hasError: boolean;
}) {
  const payload = JSON.stringify({ type: "job_update", data: job });
  for (const client of dashboardClients) {
    try {
      client.send(payload);
    } catch {
      dashboardClients.delete(client);
    }
  }
}

/** Register a WebSocket client for dashboard updates. */
export function registerDashboardClient(ws: ServerWebSocket<WSDashboardData>) {
  dashboardClients.add(ws);
  log.debug(`[ws] dashboard client connected, total=${dashboardClients.size}`);
  // Send initial connected event
  ws.send(JSON.stringify({ type: "connected" }));
}

/** Remove a WebSocket client from dashboard updates. */
export function unregisterDashboardClient(
  ws: ServerWebSocket<WSDashboardData>,
) {
  dashboardClients.delete(ws);
  log.debug(
    `[ws] dashboard client disconnected, total=${dashboardClients.size}`,
  );
}

export async function handleDashboardJobs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "50"), 1),
    200,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
  const status = url.searchParams.get("status") || undefined;

  const where = status ? { status } : {};

  const [jobs, total] = await Promise.all([
    prisma.pendingJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        sailResponseId: true,
        status: true,
        model: true,
        completionWindow: true,
        apiType: true,
        createdAt: true,
        completedAt: true,
        pollCount: true,
        errorBody: true,
      },
    }),
    prisma.pendingJob.count({ where }),
  ]);

  const result = jobs.map((job) => ({
    id: job.id,
    sailResponseId: job.sailResponseId,
    status: job.status,
    model: job.model,
    completionWindow: job.completionWindow,
    apiType: job.apiType,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs: job.completedAt
      ? job.completedAt.getTime() - job.createdAt.getTime()
      : null,
    pollCount: job.pollCount,
    hasError: job.errorBody !== null,
  }));

  return Response.json({ jobs: result, total, limit, offset });
}

export async function handleDashboardJobDetail(
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  // /api/dashboard/jobs/:id
  const segments = url.pathname.split("/");
  const id = segments[segments.length - 1];
  if (!id || id === "jobs") return openAIError(404, "Job not found");

  const job = await prisma.pendingJob.findUnique({
    where: { id },
    select: {
      id: true,
      sailResponseId: true,
      status: true,
      model: true,
      completionWindow: true,
      apiType: true,
      createdAt: true,
      completedAt: true,
      pollCount: true,
      errorBody: true,
      requestBody: true,
      responseBody: true,
    },
  });

  if (!job) return openAIError(404, "Job not found");

  return Response.json({
    id: job.id,
    sailResponseId: job.sailResponseId,
    status: job.status,
    model: job.model,
    completionWindow: job.completionWindow,
    apiType: job.apiType,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs: job.completedAt
      ? job.completedAt.getTime() - job.createdAt.getTime()
      : null,
    pollCount: job.pollCount,
    hasError: job.errorBody !== null,
    requestBody: job.requestBody,
    responseBody: job.responseBody,
    errorBody: job.errorBody,
  });
}

/** Proxy the Sail models list for the dashboard SPA, enriched with ModelMeta. */
export async function handleDashboardModels(): Promise<Response> {
  const { status, data } = await sail.listModels();
  if (status !== 200) return mapSailError(status, data);

  // Fetch all metadata and index by modelId
  const metaRows = await prisma.modelMeta.findMany();
  const metaByModelId = new Map(metaRows.map((m) => [m.modelId, m]));

  // Enrich each model with its metadata (nulls if not researched)
  const enrichedData = (data.data ?? []).map((model: any) => {
    const meta = metaByModelId.get(model.id);
    return {
      ...model,
      contextSize: meta?.contextSize ?? null,
      samplingPresets: meta ? JSON.parse(meta.samplingPresets) : null,
      description: meta?.description ?? null,
      source: meta?.source ?? null,
      researchedAt: meta?.researchedAt?.toISOString() ?? null,
    };
  });

  return Response.json({ ...data, data: enrichedData });
}
