import { researchAndUpsertOne } from "../graphql/research-models-runner.ts";
import { sail } from "../sail-client.ts";
import {
  mergeModelMeta,
  toRestShape,
  type SailUpstreamModel,
} from "../models-meta.ts";
import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";

/**
 * Handle `POST /api/models/:modelId/research`.
 *
 * Triggers the full research pipeline for a single model (pi SDK research
 * + docs scraping + DB upsert) and returns the enriched model data in the
 * same shape as `/v1/models` entries.
 */
export async function handleModelResearch(
  req: Request,
  modelId: string,
): Promise<Response> {
  // Verify the model exists in Sail upstream before doing expensive work
  const { status, data } = await sail.listModels();
  if (status !== 200) {
    return Response.json(
      { error: "Failed to fetch model list from Sail upstream" },
      { status: 502 },
    );
  }

  const list = (data?.data ?? []) as SailUpstreamModel[];
  const sailModel = list.find((m) => m.id === modelId);

  if (!sailModel) {
    return Response.json(
      { error: `Model "${modelId}" not found in Sail upstream` },
      { status: 404 },
    );
  }

  // Run research + upsert
  try {
    await researchAndUpsertOne(modelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[model-research] failed for ${modelId}: ${msg}`);
    return Response.json(
      { error: `Research failed for "${modelId}": ${msg}` },
      { status: 500 },
    );
  }

  // Return the enriched model data
  const { prisma } = await import("../db.ts");
  const meta = await prisma.modelMeta.findUnique({
    where: { modelId },
    include: { samplingPresets: true, prices: true },
  });

  const wire = mergeModelMeta(sailModel, meta ?? undefined);
  const restShape = toRestShape(wire, config.defaults.completionWindow);

  return Response.json(restShape);
}
