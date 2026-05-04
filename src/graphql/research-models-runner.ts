/**
 * Single-model wrapper around the bin/research-models flow, used by the
 * GraphQL `Mutation.refetchModel` resolver. The CLI script researches
 * every model in /v1/models; the dashboard wants to refetch one row.
 */
import { runPiResearch, upsertModelMeta } from "../research-models.ts";
import { log } from "../../shared/logger.ts";

export async function researchAndUpsertOne(modelId: string): Promise<void> {
  log.info(`[refetchModel] researching ${modelId}`);
  const result = await runPiResearch(modelId);
  await upsertModelMeta(modelId, result);
  log.info(
    `[refetchModel] upserted ${modelId} contextSize=${result.contextSize} presets=${result.samplingPresets.length}`,
  );
}
