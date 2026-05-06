/**
 * Single-model wrapper around the bin/research-models flow, used by the
 * GraphQL `Mutation.refetchModel` resolver. The CLI script researches
 * every model in /v1/models; the dashboard wants to refetch one row.
 */
import { runPiResearch, upsertModelMeta } from "../research-models.ts";
import { scrapeImageCapabilities, scrapePricing } from "../docs-scraper.ts";
import { log } from "../../shared/logger.ts";
import type { ModelPriceInput } from "../types.ts";

export async function researchAndUpsertOne(modelId: string): Promise<void> {
  log.info(`[refetchModel] researching ${modelId}`);

  // Scrape docs for pricing and image capabilities (one-shot for all models)
  let scrapedPrices: Map<string, ModelPriceInput[]> = new Map();
  let imageCapabilities: Map<string, boolean> = new Map();

  try {
    scrapedPrices = await scrapePricing();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[refetchModel] pricing scrape failed: ${msg}`);
  }

  try {
    imageCapabilities = await scrapeImageCapabilities();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[refetchModel] image capability scrape failed: ${msg}`);
  }

  // Run research for contextSize, samplingPresets, description, source
  const result = await runPiResearch(modelId);

  // Merge scraped data (authoritative)
  const scraped = scrapedPrices.get(modelId);
  if (scraped && scraped.length > 0) {
    result.prices = scraped;
  }

  const imageCap = imageCapabilities.get(modelId);
  if (imageCap !== undefined) {
    result.supportsImage = imageCap;
  }

  await upsertModelMeta(modelId, result);
  log.info(
    `[refetchModel] upserted ${modelId} contextSize=${result.contextSize} presets=${result.samplingPresets.length} supportsImage=${result.supportsImage} reasoning=${result.reasoning}`,
  );
}
