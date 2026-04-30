import { prisma } from "../db.ts";

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
