/**
 * Scrape Sail Research documentation pages and extract structured model
 * metadata using deterministic JSX parsing — no LLM calls required.
 *
 * The capabilities scraper parses `/models.md` for `supportsImage` and
 * `reasoning` booleans from the `is-true`/`is-false` CSS classes and
 * `data-cap` attributes.
 *
 * The pricing scraper parses `/pricing.md` for per-window token costs
 * from each pricing row's `aria-label` summary string.
 */
import { log } from "../shared/logger.ts";
import { type ModelPriceInput, type CompletionWindow } from "./types.ts";
import { config } from "./config.ts";
import { isValidCompletionWindow } from "./completion-window.ts";

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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(config.research.scrapeTimeoutMs),
  });
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

// ─── Deterministic pricing parser ───────────────────────────────────────────

/**
 * Deterministically parse the pricing table from the Sail docs
 * `/pricing.md` page. Each (model, window) pair is one table row whose
 * `aria-label` carries the full price summary; the model cell spans its
 * window rows via `rowSpan`:
 *
 *   <tr className="pricing-row pricing-row-window pricing-row-model-first"
 *       aria-label="Kimi-K2.6 Priority pricing: input $0.45, cached $0.20,
 *                   output $3.00 per 1M tokens.">
 *     <td className="pricing-cell pricing-cell-model" rowSpan={2} …>
 *       … <code>moonshotai/Kimi-K2.6</code> …
 *     </td>
 *     …
 *   </tr>
 *   <tr className="pricing-row pricing-row-window"
 *       aria-label="Kimi-K2.6 ASAP pricing: …">…</tr>
 *
 * We track the current model from the `<code>slug</code>` in model cells
 * and read window + prices from each row's aria-label.
 */
const PRICE_LABEL_RE =
  /aria-label="[^"]*?\b(ASAP|Priority|Standard|Flex) pricing: input \$([0-9.]+), (?:cached \$([0-9.]+), )?output \$([0-9.]+)/;

export function parsePricingFromJsx(
  markdown: string,
): Map<string, ModelPriceInput[]> {
  const map = new Map<string, ModelPriceInput[]>();

  const rows = markdown.split(/<tr className="pricing-row[\s"]/);
  let currentModel: string | null = null;

  for (const row of rows.slice(1)) {
    // A model cell (rowSpan over its window rows) starts a new model group.
    if (row.includes("pricing-cell-model")) {
      const codeMatch = row.match(/<code>([^<]+)<\/code>/);
      currentModel = codeMatch?.[1]?.trim() || null;
    }
    if (!currentModel) continue;

    const label = row.match(PRICE_LABEL_RE);
    if (!label) continue;

    const window = label[1]!.toLowerCase();
    if (!isValidCompletionWindow(window)) {
      log.warn(
        `[docs-scraper] skipping price with invalid completionWindow "${window}" for ${currentModel}`,
      );
      continue;
    }

    const input = parseFloat(label[2]!);
    const cached = label[3] !== undefined ? parseFloat(label[3]!) : null;
    const output = parseFloat(label[4]!);
    if (Number.isNaN(input) || Number.isNaN(output)) continue;

    const prices = map.get(currentModel) ?? [];
    prices.push({
      completionWindow: window as CompletionWindow,
      inputPerMTok: input,
      cachedInputPerMTok:
        cached !== null && Number.isNaN(cached) ? null : cached,
      outputPerMTok: output,
    });
    map.set(currentModel, prices);
  }

  return map;
}

/**
 * Scrape the Sail docs Pricing page and return a map of modelId →
 * validated price entries. Parsed deterministically from the JSX
 * markup — no LLM required.
 */
export async function scrapePricing(): Promise<Map<string, ModelPriceInput[]>> {
  const url = "https://docs.sailresearch.com/pricing.md";
  log.info(`[docs-scraper] fetching ${url}`);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(config.research.scrapeTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const markdown = await res.text();
  log.info(`[docs-scraper] fetched ${url} (${markdown.length} chars)`);

  const map = parsePricingFromJsx(markdown);

  log.info(
    `[docs-scraper] pricing: ${map.size} models with pricing data extracted`,
  );
  return map;
}
