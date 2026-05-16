/**
 * Scrape Sail Research documentation pages and extract structured model
 * metadata using deterministic JSX parsing — no LLM calls required.
 *
 * The capabilities scraper parses `/models.md` for `supportsImage` and
 * `reasoning` booleans from the `is-true`/`is-false` CSS classes and
 * `data-cap` attributes.
 *
 * The pricing scraper parses `/pricing.md` for per-window token costs
 * from the `price-amount` spans with `data-window` and `data-axis`
 * attributes.
 */
import { log } from "../shared/logger.ts";
import { type ModelPriceInput, type CompletionWindow } from "./types.ts";
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

// ─── Deterministic pricing parser ───────────────────────────────────────────

/**
 * Deterministically parse the pricing table from the Sail docs
 * `/pricing.md` page. The page contains JSX-rendered HTML with rows like:
 *
 *   <tr className="pricing-row">
 *     <td className="pricing-cell-model" …>
 *       <span className="cap-slug-text" title="org/model-id">…</span>
 *     </td>
 *     <td className="pricing-cell-price" data-axis="Input">
 *       <span className="price-amount" data-window="standard">$0.20</span>
 *       <span className="price-amount" data-window="flex">$0.16</span>
 *     </td>
 *     <td className="pricing-cell-price" data-axis="Cached">…</td>
 *     <td className="pricing-cell-price" data-axis="Output">…</td>
 *   </tr>
 *
 * A single row may contain multiple models (each with their own 3 price
 * cells). We extract the slug from `title="…"`, the axis from
 * `data-axis="…"`, the window from `data-window="…"`, and the dollar
 * amount from the text following the `$` currency span.
 */
export function parsePricingFromJsx(
  markdown: string,
): Map<string, ModelPriceInput[]> {
  const map = new Map<string, ModelPriceInput[]>();

  const rows = markdown.split(/<tr className="pricing-row">/);

  for (const row of rows.slice(1)) {
    // Find all model IDs in this row (title attr in cap-slug-text spans)
    const titles = [...row.matchAll(/title="([^"]+)"/g)].map((m) => m[1]!);
    if (titles.length === 0) continue;

    // Find all price cells, each with a data-axis and one or more
    // price-amount spans containing data-window + dollar value.
    const cells = row.split(/className="pricing-cell pricing-cell-price"/);

    const axisGroups: Array<{
      axis: string;
      amounts: Array<{ window: string; value: number }>;
    }> = [];

    for (const cell of cells.slice(1)) {
      const axisMatch = cell.match(/data-axis="([^"]+)"/);
      if (!axisMatch) continue;
      const axis = axisMatch[1]!;

      const amounts: Array<{ window: string; value: number }> = [];
      // Match: data-window="standard"> ... <span className="price-currency…">$</span> 0.20
      const priceMatches = cell.matchAll(
        /data-window="([^"]+)">[\s\S]*?<span className="price-currency[^"]*"[^>]*>[\s\S]*?<\/span>\s*([0-9.]+)/g,
      );
      for (const pm of priceMatches) {
        const value = parseFloat(pm[2]!);
        if (!Number.isNaN(value)) {
          amounts.push({ window: pm[1]!, value });
        }
      }

      axisGroups.push({ axis, amounts });
    }

    // Chunk axis groups into triples (Input, Cached, Output) and assign
    // one triple per model title, in order.
    const modelsInRow = titles.length;
    const groupsPerModel = 3; // Input, Cached, Output

    for (let m = 0; m < modelsInRow; m++) {
      const modelId = titles[m]!;
      if (modelId.trim() === "") continue;

      const start = m * groupsPerModel;
      const group = axisGroups.slice(start, start + groupsPerModel);
      if (group.length < groupsPerModel) {
        log.warn(
          `[docs-scraper] incomplete price cells for ${modelId}: expected ${groupsPerModel}, got ${group.length}`,
        );
        continue;
      }

      // Build per-window price entries
      const windowPrices = new Map<
        string,
        { input?: number; cached?: number; output?: number }
      >();

      for (const { axis, amounts } of group) {
        for (const { window, value } of amounts) {
          if (!windowPrices.has(window)) {
            windowPrices.set(window, {});
          }
          const wp = windowPrices.get(window)!;
          if (axis === "Input") wp.input = value;
          else if (axis === "Cached") wp.cached = value;
          else if (axis === "Output") wp.output = value;
        }
      }

      const prices: ModelPriceInput[] = [];
      for (const [window, wp] of windowPrices) {
        if (!isValidCompletionWindow(window)) {
          log.warn(
            `[docs-scraper] skipping price with invalid completionWindow "${window}" for ${modelId}`,
          );
          continue;
        }
        // Input and output are required
        if (wp.input === undefined || wp.output === undefined) continue;
        prices.push({
          completionWindow: window as CompletionWindow,
          inputPerMTok: wp.input,
          cachedInputPerMTok: wp.cached ?? null,
          outputPerMTok: wp.output,
        });
      }

      map.set(modelId, prices);
    }
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
  const res = await fetch(url);
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
