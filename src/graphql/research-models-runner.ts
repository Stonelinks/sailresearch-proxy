/**
 * Model research runner used by GraphQL mutations.
 *
 * - `researchAndUpsertOne(modelId)` — single model, scrapes docs fresh each
 *   call. Used by `refetchModel` mutation.
 * - `researchAndUpsertMany(modelIds)` — batch research, scrapes docs once
 *   and shares results across all models, runs pi research in parallel with
 *   a concurrency limit. Used by `researchAllModels` mutation.
 */
import { runPiResearch, upsertModelMeta } from "../research-models.ts";
import { scrapeModelCapabilities, scrapePricing } from "../docs-scraper.ts";
import { log } from "../../shared/logger.ts";
import type { ModelPriceInput } from "../types.ts";

// ─── Shared scraped data ─────────────────────────────────────────────────────

interface ScrapedData {
  prices: Map<string, ModelPriceInput[]>;
  capabilities: Map<string, { supportsImage: boolean; reasoning: boolean }>;
}

/**
 * Scrape docs once. Returns empty maps on failure so callers don't need
 * to handle null.
 */
async function scrapeDocs(): Promise<ScrapedData> {
  let prices: Map<string, ModelPriceInput[]> = new Map();
  let capabilities: Map<
    string,
    { supportsImage: boolean; reasoning: boolean }
  > = new Map();

  try {
    prices = await scrapePricing();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[research-runner] pricing scrape failed: ${msg}`);
  }

  try {
    capabilities = await scrapeModelCapabilities();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[research-runner] capability scrape failed: ${msg}`);
  }

  return { prices, capabilities };
}

// ─── Single model research ───────────────────────────────────────────────────

/**
 * Research a single model by modelId. Scrapes docs, runs pi research,
 * merges scraped data, and upserts into the database.
 *
 * Used by the `refetchModel` mutation.
 */
export async function researchAndUpsertOne(modelId: string): Promise<void> {
  const scraped = await scrapeDocs();
  await researchOneWithScrapedData(modelId, scraped);
}

// ─── Batch research ─────────────────────────────────────────────────────────

/**
 * Research multiple models in parallel. Scrapes docs once and shares
 * the results across all models. All pi research calls run concurrently.
 *
 * Returns an array of errors for any models that failed. Models that
 * succeed are silently upserted.
 */
export async function researchAndUpsertMany(
  modelIds: string[],
): Promise<Array<{ modelId: string; error: string }>> {
  const scraped = await scrapeDocs();
  const errors: Array<{ modelId: string; error: string }> = [];

  // Fire all research calls concurrently
  const results = await Promise.allSettled(
    modelIds.map((modelId) => researchOneWithScrapedData(modelId, scraped)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "rejected") {
      const modelId = modelIds[i]!;
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      log.error(`[researchAllModels] failed for ${modelId}: ${msg}`);
      errors.push({ modelId, error: msg });
    }
  }

  return errors;
}

// ─── Internal: research one model with pre-scraped data ─────────────────────

async function researchOneWithScrapedData(
  modelId: string,
  scraped: ScrapedData,
): Promise<void> {
  log.info(`[research-runner] researching ${modelId}`);

  // Run pi research for contextSize, samplingPresets, description, source
  const result = await runPiResearch(modelId);

  // Merge scraped data (authoritative)
  const scrapedPrices = scraped.prices.get(modelId);
  if (scrapedPrices && scrapedPrices.length > 0) {
    result.prices = scrapedPrices;
  }

  const caps = scraped.capabilities.get(modelId);
  if (caps !== undefined) {
    result.supportsImage = caps.supportsImage;
    // Only override reasoning from docs if true — docs are authoritative
    // for the boolean, but pi research may have already discovered
    // thinkingLevelMap details.
    if (caps.reasoning) {
      result.reasoning = true;
    }
  }

  await upsertModelMeta(modelId, result);
  log.info(
    `[research-runner] upserted ${modelId} contextSize=${result.contextSize} presets=${result.samplingPresets.length} supportsImage=${result.supportsImage} reasoning=${result.reasoning}`,
  );
}
