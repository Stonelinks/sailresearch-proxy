/**
 * Scrape Sail Research documentation pages and extract structured model
 * metadata using a one-shot LLM call through the embedded pi SDK.
 *
 * Two scrapers share the same pattern:
 *   1. fetch markdown page from docs.sailresearch.com
 *   2. send the raw markdown to the pi SDK with an extraction prompt
 *   3. validate the LLM JSON response
 *   4. return a typed Map<modelId, data>
 *
 * This replaces per-model research for pricing (which was slow and
 * expensive) and adds image capability metadata (which research couldn't provide).
 */
import { log } from "../shared/logger.ts";
import { type ModelPriceInput, type CompletionWindow } from "./types.ts";
import { isValidCompletionWindow } from "./completion-window.ts";
import { runPiPrompt } from "./pi-session.ts";

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
  // For the pricing page, the main pricing table ends around byte 34K, and
  // the ASAP section starts around byte 35K. We concatenate the head (main
  // table, enough to capture all models) and the tail (ASAP section) so the
  // LLM sees both. The file is ~50K total.
  let content: string;
  if (url.includes("supported-models") && markdown.length > 35_000) {
    const asapIdx = markdown.indexOf("ASAP pricing");
    const tail =
      asapIdx >= 0
        ? "\n\n--- ASAP SECTION ---\n" +
          markdown.slice(Math.max(0, asapIdx - 200))
        : "";
    content = markdown.slice(0, 34_000) + tail;
  } else {
    content =
      markdown.length > 30_000
        ? markdown.slice(0, 30_000) + "\n... [truncated]"
        : markdown;
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

/**
 * Extract a JSON object from raw LLM output.
 * Handles both raw JSON and markdown-fenced JSON.
 */
function extractJson(raw: string): string | null {
  // Try markdown code fences first
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Try raw JSON object (first { ... } block)
  const lines = raw.split("\n");
  let start = -1;
  let braceCount = 0;
  const jsonLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (start === -1) {
      if (line.trimStart().startsWith("{")) {
        start = i;
        braceCount += (line.match(/{/g) ?? []).length;
        braceCount -= (line.match(/}/g) ?? []).length;
        jsonLines.push(line);
        if (braceCount === 0) break;
      }
    } else {
      braceCount += (line.match(/{/g) ?? []).length;
      braceCount -= (line.match(/}/g) ?? []).length;
      jsonLines.push(line);
      if (braceCount === 0) break;
    }
  }

  if (jsonLines.length > 0) {
    return jsonLines.join("\n");
  }

  return null;
}

// ─── Image capabilities ─────────────────────────────────────────────────────

const IMAGE_PROMPT = `Extract the list of models that support image/multimodal input from this documentation page.

Return a JSON object with a single key "models" which is an array of objects, each with:
- "modelId": the exact model ID string (e.g. "moonshotai/Kimi-K2.5")
- "supportsImage": true

Only include models explicitly listed as supporting multimodal/image input. Do not infer or guess.

Example output:
{"models": [{"modelId": "org/model-name", "supportsImage": true}]}`;

export interface ImageCapabilityEntry {
  modelId: string;
  supportsImage: boolean;
}

interface ImageCapabilitiesResult {
  models: ImageCapabilityEntry[];
}

/**
 * Scrape the Sail docs Image Input page and return a map of modelId →
 * whether the model supports image input.
 */
export async function scrapeImageCapabilities(): Promise<Map<string, boolean>> {
  const { data } = await fetchAndParseDocsPage<ImageCapabilitiesResult>(
    "https://docs.sailresearch.com/images.md",
    IMAGE_PROMPT,
  );

  if (!Array.isArray(data.models)) {
    throw new Error(
      `Expected "models" array in image capabilities response, got: ${typeof data.models}`,
    );
  }

  const map = new Map<string, boolean>();
  for (const entry of data.models) {
    if (typeof entry.modelId !== "string" || entry.modelId.trim() === "") {
      log.warn(
        `[docs-scraper] skipping invalid image capability entry: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    map.set(entry.modelId, Boolean(entry.supportsImage));
  }

  log.info(
    `[docs-scraper] image capabilities: ${map.size} models found with image support`,
  );
  return map;
}

// ─── Pricing ────────────────────────────────────────────────────────────────

const PRICING_PROMPT = `Extract the pricing information for ALL models from this documentation page.

The page contains pricing tables for different completion windows (Standard, Priority, Flex, ASAP). Each row has a model ID and prices in USD per 1M tokens.

CRITICAL: You must extract pricing for EVERY model in EVERY table. Some models appear in both the main table (Standard+Priority+Flex) AND the ASAP table. A model that has dash columns (—) in a window does NOT support that window — omit that price entry.

Return a JSON object with a single key "models" which is an array of objects, each with:
- "modelId": the exact model ID string (e.g. "moonshotai/Kimi-K2.5")
- "prices": an array of price entries, each with:
  - "completionWindow": one of "asap", "priority", "standard", "flex"
  - "inputPerMTok": number (USD per 1M input tokens), or null if shown as dash
  - "cachedInputPerMTok": number (USD per 1M cached input tokens), or null if shown as dash or not available
  - "outputPerMTok": number (USD per 1M output tokens), or null if shown as dash

Include ALL models from ALL tables on the page (Standard+Priority+Flex table AND the ASAP table).

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
 * Scrape the Sail docs Models & Pricing page and return a map of modelId →
 * validated price entries.
 */
export async function scrapePricing(): Promise<Map<string, ModelPriceInput[]>> {
  const { data } = await fetchAndParseDocsPage<PricingResult>(
    "https://docs.sailresearch.com/supported-models.md",
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
