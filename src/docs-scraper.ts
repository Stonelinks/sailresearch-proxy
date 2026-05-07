/**
 * Scrape Sail Research documentation pages and extract structured model
 * metadata using a one-shot LLM call through the embedded pi SDK.
 *
 * Two scrapers share the same pattern:
 *   1. fetch markdown/MDX page from docs.sailresearch.com
 *   2. send the raw content to the pi SDK with an extraction prompt
 *   3. validate the LLM JSON response
 *   4. return a typed Map<modelId, data>
 *
 * The pricing scraper fetches `/pricing.md` for per-window token costs.
 * The capabilities scraper fetches `/models.md` for image support and
 * reasoning flags — both from the same capabilities table.
 */
import { log } from "../shared/logger.ts";
import { type ModelPriceInput, type CompletionWindow } from "./types.ts";
import { isValidCompletionWindow } from "./completion-window.ts";
import { runPiPrompt } from "./pi-session.ts";
import { extractJson } from "../shared/extract-json.ts";

// ─── Shared LLM extraction ──────────────────────────────────────────────────

interface ExtractionResult<T> {
  data: T;
  raw: string;
}

/**
 * Fetch a Sail docs markdown page, send it to the pi SDK with an
 * extraction prompt, and return the parsed JSON. Validates that the LLM
 * returned valid JSON; throws with a descriptive message otherwise.
 */
async function fetchAndParseDocsPage<T>(
  url: string,
  userPrompt: string,
): Promise<ExtractionResult<T>> {
  // 1. Fetch the markdown page
  log.info(`[docs-scraper] fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const markdown = await res.text();
  log.info(`[docs-scraper] fetched ${url} (${markdown.length} chars)`);

  // 2. Prepare content — truncate large pages to fit context window
  let content: string;
  if (markdown.length > 30_000) {
    content = markdown.slice(0, 30_000) + "\n... [truncated]";
  } else {
    content = markdown;
  }

  // 3. Send to pi SDK for extraction
  const raw = await runPiPrompt(`${userPrompt}\n\n---\n\n${content}`);

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("LLM returned empty content");
  }

  // 4. Extract JSON from the response (handles markdown fences)
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    throw new Error(`No JSON object found in LLM output: ${raw.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Invalid JSON from LLM: ${(e as Error).message}\nRaw: ${jsonStr.slice(0, 300)}`,
    );
  }

  return { data: parsed as T, raw: jsonStr };
}

// ─── Model capabilities (image + reasoning) ─────────────────────────────────

const CAPABILITIES_PROMPT = `Extract the capabilities for ALL models from this documentation page.

The page contains a table with columns: Model, Slug, Image, LoRA, Reasoning. Each row has a model ID (slug) and boolean checkmarks for Image and Reasoning support.

Return a JSON object with a single key "models" which is an array of objects, each with:
- "modelId": the exact model ID / slug string (e.g. "moonshotai/Kimi-K2.5")
- "supportsImage": true if the Image column shows a checkmark for this model, false otherwise
- "reasoning": true if the Reasoning column shows a checkmark for this model, false otherwise

Include EVERY model in the table, even those with no checkmarks.

Example output:
{"models": [{"modelId": "org/model-name", "supportsImage": true, "reasoning": false}]}`;

export interface ModelCapabilityEntry {
  modelId: string;
  supportsImage: boolean;
  reasoning: boolean;
}

interface ModelCapabilitiesResult {
  models: ModelCapabilityEntry[];
}

/**
 * Scrape the Sail docs Models page and return a map of modelId →
 * capabilities (supportsImage, reasoning). Both fields come from the
 * capabilities table on the /models page.
 */
export async function scrapeModelCapabilities(): Promise<
  Map<string, { supportsImage: boolean; reasoning: boolean }>
> {
  const { data } = await fetchAndParseDocsPage<ModelCapabilitiesResult>(
    "https://docs.sailresearch.com/models.md",
    CAPABILITIES_PROMPT,
  );

  if (!Array.isArray(data.models)) {
    throw new Error(
      `Expected "models" array in capabilities response, got: ${typeof data.models}`,
    );
  }

  const map = new Map<string, { supportsImage: boolean; reasoning: boolean }>();
  for (const entry of data.models) {
    if (typeof entry.modelId !== "string" || entry.modelId.trim() === "") {
      log.warn(
        `[docs-scraper] skipping invalid capability entry: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    map.set(entry.modelId, {
      supportsImage: Boolean(entry.supportsImage),
      reasoning: Boolean(entry.reasoning),
    });
  }

  log.info(
    `[docs-scraper] capabilities: ${map.size} models extracted from models page`,
  );
  return map;
}

// ─── Backwards-compatible alias for generate-models-json.ts ────────────

/**
 * @deprecated Use scrapeModelCapabilities() instead, which returns both
 * supportsImage and reasoning from the models page.
 */
export async function scrapeImageCapabilities(): Promise<Map<string, boolean>> {
  const caps = await scrapeModelCapabilities();
  const map = new Map<string, boolean>();
  for (const [modelId, cap] of caps) {
    map.set(modelId, cap.supportsImage);
  }
  return map;
}

const PRICING_PROMPT = `Extract the pricing information for ALL models from this documentation page.

The page contains a pricing table with per-window prices (Standard, Priority, Flex, ASAP). Each model row shows Input, Cached, and Output prices in USD per 1M tokens for each completion window it supports. Some models only have prices for certain windows (e.g. flex-only models).

CRITICAL: You must extract pricing for EVERY model for EVERY window they support. A model that does not show a price for a particular window does NOT support that window — omit that price entry.

Return a JSON object with a single key "models" which is an array of objects, each with:
- "modelId": the exact model ID string (e.g. "moonshotai/Kimi-K2.5")
- "prices": an array of price entries, each with:
  - "completionWindow": one of "asap", "priority", "standard", "flex"
  - "inputPerMTok": number (USD per 1M input tokens), or null if shown as dash
  - "cachedInputPerMTok": number (USD per 1M cached input tokens), or null if shown as dash or not available
  - "outputPerMTok": number (USD per 1M output tokens), or null if shown as dash

Include ALL models from ALL windows on the page.

Example output:
{"models": [{"modelId": "org/model-name", "prices": [{"completionWindow": "standard", "inputPerMTok": 0.20, "cachedInputPerMTok": 0.10, "outputPerMTok": 1.20}]}]}`;

interface PricingEntry {
  modelId: string;
  prices: Array<{
    completionWindow: string;
    inputPerMTok: number | null;
    cachedInputPerMTok: number | null;
    outputPerMTok: number | null;
  }>;
}

interface PricingResult {
  models: PricingEntry[];
}

/**
 * Scrape the Sail docs Pricing page and return a map of modelId →
 * validated price entries.
 */
export async function scrapePricing(): Promise<Map<string, ModelPriceInput[]>> {
  const { data } = await fetchAndParseDocsPage<PricingResult>(
    "https://docs.sailresearch.com/pricing.md",
    PRICING_PROMPT,
  );

  if (!Array.isArray(data.models)) {
    throw new Error(
      `Expected "models" array in pricing response, got: ${typeof data.models}`,
    );
  }

  const map = new Map<string, ModelPriceInput[]>();

  for (const entry of data.models) {
    if (typeof entry.modelId !== "string" || entry.modelId.trim() === "") {
      log.warn(
        `[docs-scraper] skipping invalid pricing entry: ${JSON.stringify(entry)}`,
      );
      continue;
    }

    const prices: ModelPriceInput[] = [];

    for (const p of entry.prices ?? []) {
      // Skip entries with null required values or invalid completion windows
      if (
        typeof p.inputPerMTok !== "number" ||
        typeof p.outputPerMTok !== "number"
      ) {
        continue;
      }
      if (!isValidCompletionWindow(p.completionWindow)) {
        log.warn(
          `[docs-scraper] skipping price with invalid completionWindow "${p.completionWindow}" for ${entry.modelId}`,
        );
        continue;
      }
      prices.push({
        completionWindow: p.completionWindow as CompletionWindow,
        inputPerMTok: p.inputPerMTok,
        cachedInputPerMTok:
          typeof p.cachedInputPerMTok === "number"
            ? p.cachedInputPerMTok
            : null,
        outputPerMTok: p.outputPerMTok,
      });
    }

    map.set(entry.modelId, prices);
  }

  log.info(
    `[docs-scraper] pricing: ${map.size} models with pricing data extracted`,
  );
  return map;
}
