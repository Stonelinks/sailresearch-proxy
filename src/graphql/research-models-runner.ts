/**
 * Model research runner used by GraphQL mutations.
 *
 * - `researchAndUpsertOne(modelId)` — single model, scrapes docs fresh each
 *   call. Used by `refetchModel` mutation.
 * - `researchAndUpsertMany(modelIds)` — batch research, scrapes docs once
 *   and shares results across all models, runs pi research in parallel with
 *   a concurrency limit. Used by `researchAllModels` mutation.
 */
import {
  runPiResearch,
  upsertModelMeta,
  smokeTestPresets,
  smokeTestWindowCompatibility,
  type SmokeTestResult,
} from "../research-models.ts";
import { scrapeModelCapabilities, scrapePricing } from "../docs-scraper.ts";
import { log } from "../../shared/logger.ts";
import type { ModelPriceInput, SamplingPresetInput } from "../types.ts";
import { researchTracker } from "./research-tracker.ts";

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
  researchTracker.startModel(modelId);
  try {
    const scraped = await scrapeDocs();
    await researchOneWithScrapedData(modelId, scraped);
    researchTracker.completeModel(modelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    researchTracker.failModel(modelId, msg);
    throw err;
  }
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
  researchTracker.startBatch(modelIds);
  const scraped = await scrapeDocs();
  const errors: Array<{ modelId: string; error: string }> = [];

  // Fire all research calls concurrently
  const results = await Promise.allSettled(
    modelIds.map((modelId) => {
      researchTracker.startModel(modelId);
      return researchOneWithScrapedData(modelId, scraped)
        .then(() => {
          researchTracker.completeModel(modelId);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          researchTracker.failModel(modelId, msg);
          throw err;
        });
    }),
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

  // Batch is auto-ended by completeModel/failModel when all are accounted for
  return errors;
}

// ─── Internal: research one model with pre-scraped data ─────────────────────

async function researchOneWithScrapedData(
  modelId: string,
  scraped: ScrapedData,
): Promise<void> {
  log.info(`[research-runner] researching ${modelId}`);

  // Wipe old model data before re-researching — clean slate
  const { prisma } = await import("../db.ts");
  await prisma.modelMeta.deleteMany({ where: { modelId } });

  // Run pi research for contextSize, samplingPresets, description, source
  const result = await runPiResearch(modelId);

  // Merge scraped data (authoritative)
  const scrapedPrices = scraped.prices.get(modelId);
  if (scrapedPrices && scrapedPrices.length > 0) {
    result.prices = scrapedPrices;
  }

  const caps = scraped.capabilities.get(modelId);
  if (caps !== undefined) {
    // Docs are authoritative for both supportsImage and reasoning.
    // If docs say reasoning=false, that overrides pi research (which
    // may incorrectly flag non-reasoning models). Models not found
    // on the docs page fall back to pi research results.
    result.supportsImage = caps.supportsImage;
    result.reasoning = caps.reasoning;
  }

  // Smoke test presets through the proxy
  const smokeResults = await runSmokeTestsWithFallback(
    modelId,
    result.samplingPresets,
    result.thinkingLevelMap,
  );

  // Smoke test window compatibility
  const windowCompat = await runWindowCompatWithFallback(modelId);
  if (windowCompat !== null) {
    result.supportedWindows = [...windowCompat];
  }

  // Filter out presets that failed the base-param smoke test
  const failedPresetNames = new Set<string>();
  const failedThinkingLevels = new Set<string>();

  for (const sr of smokeResults) {
    if (sr.ok) continue;
    if (sr.thinkingLevel !== null) {
      failedThinkingLevels.add(sr.thinkingLevel);
      log.warn(
        `[research-runner] smoke test FAILED: ${modelId} preset="${sr.presetName}" thinkingLevel=${sr.thinkingLevel} — ${sr.error}`,
      );
    } else {
      failedPresetNames.add(sr.presetName);
      log.warn(
        `[research-runner] smoke test FAILED: ${modelId} preset="${sr.presetName}" base params — ${sr.error}`,
      );
    }
  }

  if (failedPresetNames.size > 0) {
    result.samplingPresets = result.samplingPresets.filter(
      (p) => !failedPresetNames.has(p.name),
    );
    log.info(
      `[research-runner] removed ${failedPresetNames.size} failed presets from ${modelId}: ${[...failedPresetNames].join(", ")}`,
    );
  }

  // Remove thinking levels that failed (but the preset base params were ok)
  if (result.thinkingLevelMap && failedThinkingLevels.size > 0) {
    for (const level of failedThinkingLevels) {
      if (level in result.thinkingLevelMap) {
        result.thinkingLevelMap[level] = null;
        log.info(
          `[research-runner] disabled thinking level "${level}" for ${modelId}`,
        );
      }
    }
  }

  await upsertModelMeta(modelId, result);
  log.info(
    `[research-runner] upserted ${modelId} contextSize=${result.contextSize} presets=${result.samplingPresets.length} supportsImage=${result.supportsImage} reasoning=${result.reasoning}`,
  );
}

/**
 * Run smoke tests for presets, but skip gracefully if the proxy is
 * unreachable. Returns empty array (no failures) on connection error
 * so research can proceed — smoke tests are a validation step, not
 * a gatekeeper.
 */
async function runSmokeTestsWithFallback(
  modelId: string,
  presets: SamplingPresetInput[],
  thinkingLevelMap: Record<string, string | null> | null,
): Promise<SmokeTestResult[]> {
  try {
    return await smokeTestPresets(modelId, presets, thinkingLevelMap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `[research-runner] smoke tests skipped for ${modelId} (proxy unreachable?): ${msg}`,
    );
    return [];
  }
}

/**
 * Run window compatibility smoke test, but skip gracefully if the proxy is
 * unreachable. Returns null on connection error so research can proceed —
 * window compatibility is a validation step, not a gatekeeper.
 */
async function runWindowCompatWithFallback(
  modelId: string,
): Promise<Set<import("../types.ts").CompletionWindow> | null> {
  try {
    return await smokeTestWindowCompatibility(modelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `[research-runner] window compatibility test skipped for ${modelId} (proxy unreachable?): ${msg}`,
    );
    return null;
  }
}
