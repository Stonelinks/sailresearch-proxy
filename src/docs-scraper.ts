/**
 * Scrape Sail Research documentation pages and extract structured model
 * metadata.
 *
 * The capabilities scraper deterministically parses the JSX table from
 * `/models.md` — no LLM required. It extracts `supportsImage` and
 * `reasoning` booleans from the `is-true`/`is-false` CSS classes and
 * `data-cap` attributes in each table row.
 *
 * The pricing scraper fetches `/pricing.md` for per-window token costs
 * and uses a one-shot LLM call to extract structured data from the
 * more complex pricing tables.
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

// ─── Deterministic capabilities parser ──────────────────────────────────────

/**
 * Deterministically parse the capabilities table from the Sail docs
 * `/models.md` page. The page contains JSX-rendered HTML with rows like:
 *
 *   <tr className="cap-row">
 *     …
 *     <td className="cap-cell cap-cell-bool is-true" data-cap="Image">…</td>
 *     <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
 *     …
 *     <a className="cap-slug-link" … title="org/model-id" …>
 *   </tr>
 *
 * We extract the slug from `title="…"` and boolean values from
 * `is-true`/`is-false` class + `data-cap="…"` attribute pairs.
 */
export function parseCapabilitiesFromJsx(
  markdown: string,
): Map<string, { supportsImage: boolean; reasoning: boolean }> {
  const map = new Map<string, { supportsImage: boolean; reasoning: boolean }>();

  // Split on each table row. Handles both "cap-row" and "cap-row cap-row-last".
  const rows = markdown.split(/<tr className="cap-row[^"]*">/);

  for (const row of rows.slice(1)) {
    // Extract slug from title="org/model-id"
    const slugMatch = row.match(/title="([^"]+)"/);
    if (!slugMatch) continue;
    const modelId = slugMatch[1]!;
    if (modelId.trim() === "") continue;

    // Extract all capability cells: is-true/is-false + data-cap="…"
    const capCells = row.matchAll(/is-(true|false).*?data-cap="([^"]+)"/g);

    let supportsImage = false;
    let reasoning = false;

    for (const match of capCells) {
      const value = match[1] === "true";
      const cap = match[2]!;
      if (cap === "Image") supportsImage = value;
      else if (cap === "Reasoning") reasoning = value;
    }

    map.set(modelId, { supportsImage, reasoning });
  }

  return map;
}

/**
 * Scrape the Sail docs Models page and return a map of modelId →
 * capabilities (supportsImage, reasoning). Both fields come from the
 * capabilities table on the /models page, parsed deterministically
 * from the JSX markup — no LLM required.
 */
export async function scrapeModelCapabilities(): Promise<
  Map<string, { supportsImage: boolean; reasoning: boolean }>
> {
  const url = "https://docs.sailresearch.com/models.md";
  log.info(`[docs-scraper] fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const markdown = await res.text();
  log.info(`[docs-scraper] fetched ${url} (${markdown.length} chars)`);

  const map = parseCapabilitiesFromJsx(markdown);

  log.info(
    `[docs-scraper] capabilities: ${map.size} models extracted from models page`,
  );
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
