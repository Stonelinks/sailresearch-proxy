import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  parseCapabilitiesFromJsx,
  scrapeModelCapabilities,
  parsePricingFromJsx,
  scrapePricing,
} from "./docs-scraper.ts";

// ─── Realistic JSX snippets from docs.sailresearch.com/models.md ──────────

/** A single table row for a model with Image=true, Reasoning=false */
const ROW_IMAGE_ONLY = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model" style={{ width: "14.0rem", minWidth: "14.0rem" }}>
          <span className="cap-logo" data-org="moonshot" role="img" aria-label="Moonshot AI" />
          <div className="cap-model-meta">
            <div className="cap-model-name">Kimi K2.5</div>
            <div className="cap-creator">Moonshot AI</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <div className="cap-slug-actions">
            <a className="cap-slug-link" href="https://huggingface.co/moonshotai/Kimi-K2.5" title="moonshotai/Kimi-K2.5" target="_blank" rel="noopener">
              <code>moonshotai/Kimi-K2.5</code>
            </a>
          </div>
        </td>
        <td className="cap-cell cap-cell-bool is-true" data-cap="Image">
          <svg className="cap-check"><path d="M20 6 9 17l-5-5" /></svg>
        </td>
        <td className="cap-cell cap-cell-bool is-true" data-cap="LoRA">
          <svg className="cap-check"><path d="M20 6 9 17l-5-5" /></svg>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
      </tr>`;

/** A single table row for a model with Image=false, Reasoning=true */
const ROW_REASONING_ONLY = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">GLM-5.1 (FP8)</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/zai-org/GLM-5.1-FP8" title="zai-org/GLM-5.1-FP8" target="_blank" rel="noopener">
            <code>zai-org/GLM-5.1-FP8</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="Image" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="LoRA" />
        <td className="cap-cell cap-cell-bool is-true" data-cap="Reasoning">
          <svg className="cap-check"><path d="M20 6 9 17l-5-5" /></svg>
        </td>
      </tr>`;

/** A row with cap-row-last class variant (last row in table) */
const ROW_LAST = `<tr className="cap-row cap-row-last">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">Gemma 4 31B IT</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/google/gemma-4-31B-it" title="google/gemma-4-31B-it" target="_blank" rel="noopener">
            <code>google/gemma-4-31B-it</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-true" data-cap="Image">
          <svg className="cap-check"><path d="M20 6 9 17l-5-5" /></svg>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="LoRA" />
        <td className="cap-cell cap-cell-bool is-true" data-cap="Reasoning">
          <svg className="cap-check"><path d="M20 6 9 17l-5-5" /></svg>
        </td>
      </tr>`;

/** A row with no capabilities checked (model 1) */
const ROW_NONE_1 = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">DeepSeek V3.2</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/deepseek-ai/DeepSeek-V3.2" title="deepseek-ai/DeepSeek-V3.2" target="_blank" rel="noopener">
            <code>deepseek-ai/DeepSeek-V3.2</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="Image" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="LoRA" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
      </tr>`;

/** A row with no capabilities checked (model 2) */
const ROW_NONE_2 = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">gpt-oss-120b</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/openai/gpt-oss-120b" title="openai/gpt-oss-120b" target="_blank" rel="noopener">
            <code>openai/gpt-oss-120b</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="Image" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="LoRA" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
      </tr>`;

/** A row with no capabilities checked (model 3) */
const ROW_NONE_3 = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">MiniMax M2.7</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/MiniMaxAI/MiniMax-M2.7" title="MiniMaxAI/MiniMax-M2.7" target="_blank" rel="noopener">
            <code>MiniMaxAI/MiniMax-M2.7</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-false" data-cap="Image" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="LoRA" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
      </tr>`;

/** A row without a title attribute (should be skipped) */
const ROW_NO_SLUG = `<tr className="cap-row">
        <td className="cap-cell cap-cell-model">
          <div className="cap-model-meta">
            <div className="cap-model-name">Mystery Model</div>
          </div>
        </td>
        <td className="cap-cell cap-cell-slug">
          <a className="cap-slug-link" href="https://huggingface.co/org/model">
            <code>org/model</code>
          </a>
        </td>
        <td className="cap-cell cap-cell-bool is-true" data-cap="Image" />
        <td className="cap-cell cap-cell-bool is-false" data-cap="Reasoning" />
      </tr>`;

/** Full realistic page from docs.sailresearch.com/models.md */
const FULL_REALISTIC_PAGE = `> ## Documentation Index
> Fetch the complete documentation index at: https://docs.sailresearch.com/llms.txt

# Models

> All models currently served by Sail

{/* Capability rows below are auto-generated from config/models.json */}

<div className="capabilities-table-wrapper">
  <table className="capabilities-table">
    <thead>
      <tr className="cap-header-row">
        <th className="cap-th cap-th-model" style={{ width: "14.0rem", minWidth: "14.0rem" }}>
          Model
        </th>
        <th className="cap-th cap-th-slug">Slug</th>
        <th className="cap-th cap-th-bool" style={{ width: "6.0rem" }}>
          <a className="cap-th-link" href="/images">Image</a>
        </th>
        <th className="cap-th cap-th-bool" style={{ width: "6.0rem" }}>
          <a className="cap-th-link" href="/loras">LoRA</a>
        </th>
        <th className="cap-th cap-th-bool" style={{ width: "6.0rem" }}>
          Reasoning
        </th>
      </tr>
    </thead>
    <tbody>
${ROW_IMAGE_ONLY}
${ROW_REASONING_ONLY}
${ROW_NONE_1}
${ROW_NONE_2}
${ROW_NONE_3}
${ROW_LAST}
    </tbody>
  </table>
</div>

* Each row links the exact Hugging Face checkpoint Sail currently serves.
* For per-model rates by completion window, see [Pricing](/pricing).`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("parseCapabilitiesFromJsx", () => {
  test("parses a single row with Image=true, Reasoning=false", () => {
    const map = parseCapabilitiesFromJsx(ROW_IMAGE_ONLY);
    expect(map.size).toBe(1);
    expect(map.get("moonshotai/Kimi-K2.5")).toEqual({
      supportsImage: true,
      reasoning: false,
    });
  });

  test("parses a single row with Image=false, Reasoning=true", () => {
    const map = parseCapabilitiesFromJsx(ROW_REASONING_ONLY);
    expect(map.size).toBe(1);
    expect(map.get("zai-org/GLM-5.1-FP8")).toEqual({
      supportsImage: false,
      reasoning: true,
    });
  });

  test("handles cap-row cap-row-last class variant", () => {
    const map = parseCapabilitiesFromJsx(ROW_LAST);
    expect(map.size).toBe(1);
    expect(map.get("google/gemma-4-31B-it")).toEqual({
      supportsImage: true,
      reasoning: true,
    });
  });

  test("parses a row with no capabilities checked", () => {
    const map = parseCapabilitiesFromJsx(ROW_NONE_1);
    expect(map.size).toBe(1);
    expect(map.get("deepseek-ai/DeepSeek-V3.2")).toEqual({
      supportsImage: false,
      reasoning: false,
    });
  });

  test("skips rows without a title attribute (no slug)", () => {
    const map = parseCapabilitiesFromJsx(ROW_NO_SLUG);
    expect(map.size).toBe(0);
  });

  test("returns empty map for content with no capability rows", () => {
    const map = parseCapabilitiesFromJsx("<p>Hello world</p>");
    expect(map.size).toBe(0);
  });

  test("returns empty map for empty string", () => {
    const map = parseCapabilitiesFromJsx("");
    expect(map.size).toBe(0);
  });

  test("parses multiple rows from a full realistic page", () => {
    const map = parseCapabilitiesFromJsx(FULL_REALISTIC_PAGE);
    expect(map.size).toBe(6);
    expect(map.get("moonshotai/Kimi-K2.5")).toEqual({
      supportsImage: true,
      reasoning: false,
    });
    expect(map.get("zai-org/GLM-5.1-FP8")).toEqual({
      supportsImage: false,
      reasoning: true,
    });
    expect(map.get("deepseek-ai/DeepSeek-V3.2")).toEqual({
      supportsImage: false,
      reasoning: false,
    });
    expect(map.get("openai/gpt-oss-120b")).toEqual({
      supportsImage: false,
      reasoning: false,
    });
    expect(map.get("MiniMaxAI/MiniMax-M2.7")).toEqual({
      supportsImage: false,
      reasoning: false,
    });
    expect(map.get("google/gemma-4-31B-it")).toEqual({
      supportsImage: true,
      reasoning: true,
    });
  });

  // Snapshot test: the expected output for the full realistic page should
  // not change unless the docs page format drifts.
  test("snapshot: full realistic page produces stable output", () => {
    const map = parseCapabilitiesFromJsx(FULL_REALISTIC_PAGE);
    const entries = [...map.entries()].map(([id, caps]) => ({
      modelId: id,
      ...caps,
    }));
    expect(entries).toMatchSnapshot("full-page-capabilities");
  });
});

// ─── Realistic JSX snippets from docs.sailresearch.com/pricing.md ──────────

/** A model group with all 4 windows (real snippet shape, 2026-07). */
const PRICING_GROUP_FULL = `<tr className="pricing-row pricing-row-window pricing-row-model-first" aria-label="GLM-5.2 Standard pricing: input $0.50, cached $0.12, output $2.50 per 1M tokens.">
          <td className="pricing-cell pricing-cell-model" rowSpan={4} style={{ width: "18.0rem", minWidth: "18.0rem" }}>
            <div className="pricing-cell-model-inner">
              <span className="cap-logo" data-org="zai" role="img" aria-label="Z.ai" />
              <div className="pricing-model-meta">
                <div className="cap-model-name">GLM-5.2</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="zai-org/GLM-5.2-FP8">
                    <code>zai-org/GLM-5.2-FP8</code>
                  </span>
                  <button type="button" className="cap-copy-btn" aria-label="Copy zai-org/GLM-5.2-FP8">…</button>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-window">Standard</td>
          <td className="pricing-cell pricing-cell-price">$0.50</td>
          <td className="pricing-cell pricing-cell-price">$0.12</td>
          <td className="pricing-cell pricing-cell-price">$2.50</td>
        </tr>
        <tr className="pricing-row pricing-row-window" aria-label="GLM-5.2 Priority pricing: input $0.70, cached $0.18, output $3.00 per 1M tokens.">
          <td className="pricing-cell pricing-cell-window">Priority</td>
        </tr>
        <tr className="pricing-row pricing-row-window" aria-label="GLM-5.2 Flex pricing: input $0.40, cached $0.08, output $1.80 per 1M tokens.">
          <td className="pricing-cell pricing-cell-window">Flex</td>
        </tr>
        <tr className="pricing-row pricing-row-window pricing-row-model-last" aria-label="GLM-5.2 ASAP pricing: input $1.40, cached $0.26, output $4.40 per 1M tokens.">
          <td className="pricing-cell pricing-cell-window">ASAP</td>
        </tr>`;

/** A model group with 2 windows (priority, asap). */
const PRICING_GROUP_PARTIAL = `<tr className="pricing-row pricing-row-window pricing-row-model-first" aria-label="gpt-oss-120b Priority pricing: input $0.04, cached $0.02, output $0.30 per 1M tokens.">
          <td className="pricing-cell pricing-cell-model" rowSpan={2}>
            <div className="pricing-cell-model-inner">
              <div className="pricing-model-meta">
                <div className="cap-model-name">gpt-oss-120b</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="openai/gpt-oss-120b">
                    <code>openai/gpt-oss-120b</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-window">Priority</td>
        </tr>
        <tr className="pricing-row pricing-row-window pricing-row-model-last" aria-label="gpt-oss-120b ASAP pricing: input $0.06, cached $0.03, output $0.40 per 1M tokens.">
          <td className="pricing-cell pricing-cell-window">ASAP</td>
        </tr>`;

/** A model group with a single window and a decimal-heavy cached price. */
const PRICING_GROUP_SINGLE = `<tr className="pricing-row pricing-row-window pricing-row-model-first pricing-row-model-last" aria-label="Qwen3.6 35B A3B Flex pricing: input $0.05, cached $0.015, output $0.40 per 1M tokens.">
          <td className="pricing-cell pricing-cell-model" rowSpan={1}>
            <div className="pricing-cell-model-inner">
              <div className="pricing-model-meta">
                <div className="cap-model-name">Qwen3.6 35B A3B</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="Qwen/Qwen3.6-35B-A3B">
                    <code>Qwen/Qwen3.6-35B-A3B</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-window">Flex</td>
        </tr>`;

/** Full realistic pricing page */
const FULL_PRICING_PAGE = `# Pricing

> Per-token pricing for Sail inference

<div className="pricing-table-page">
  <table className="pricing-table">
    <thead>
      <tr className="pricing-header-row">
        <th className="pricing-th pricing-th-model">Model</th>
      </tr>
    </thead>
    <tbody className="pricing-model-group">
${PRICING_GROUP_FULL}
    </tbody>
    <tbody className="pricing-model-group">
${PRICING_GROUP_PARTIAL}
    </tbody>
    <tbody className="pricing-model-group">
${PRICING_GROUP_SINGLE}
    </tbody>
  </table>
</div>`;

// ─── Pricing parser tests ─────────────────────────────────────────────────

describe("parsePricingFromJsx", () => {
  test("parses a model with all 4 windows", () => {
    const map = parsePricingFromJsx(PRICING_GROUP_FULL);
    expect(map.size).toBe(1);
    const prices = map.get("zai-org/GLM-5.2-FP8")!;
    expect(prices.length).toBe(4);

    const standard = prices.find((p) => p.completionWindow === "standard")!;
    expect(standard.inputPerMTok).toBe(0.5);
    expect(standard.cachedInputPerMTok).toBe(0.12);
    expect(standard.outputPerMTok).toBe(2.5);

    const flex = prices.find((p) => p.completionWindow === "flex")!;
    expect(flex.inputPerMTok).toBe(0.4);
    expect(flex.cachedInputPerMTok).toBe(0.08);
    expect(flex.outputPerMTok).toBe(1.8);

    const asap = prices.find((p) => p.completionWindow === "asap")!;
    expect(asap.inputPerMTok).toBe(1.4);
    expect(asap.cachedInputPerMTok).toBe(0.26);
    expect(asap.outputPerMTok).toBe(4.4);
  });

  test("parses a model with only 2 windows (priority, asap)", () => {
    const map = parsePricingFromJsx(PRICING_GROUP_PARTIAL);
    expect(map.size).toBe(1);
    const prices = map.get("openai/gpt-oss-120b")!;
    expect(prices.length).toBe(2);

    const priority = prices.find((p) => p.completionWindow === "priority")!;
    expect(priority.inputPerMTok).toBe(0.04);
    expect(priority.cachedInputPerMTok).toBe(0.02);
    expect(priority.outputPerMTok).toBe(0.3);

    const asap = prices.find((p) => p.completionWindow === "asap")!;
    expect(asap.inputPerMTok).toBe(0.06);
    expect(asap.cachedInputPerMTok).toBe(0.03);
    expect(asap.outputPerMTok).toBe(0.4);
  });

  test("parses a single-window model with decimal cached price", () => {
    const map = parsePricingFromJsx(PRICING_GROUP_SINGLE);
    expect(map.size).toBe(1);
    const prices = map.get("Qwen/Qwen3.6-35B-A3B")!;
    expect(prices.length).toBe(1);
    expect(prices[0]!.completionWindow).toBe("flex");
    expect(prices[0]!.inputPerMTok).toBe(0.05);
    expect(prices[0]!.cachedInputPerMTok).toBe(0.015);
    expect(prices[0]!.outputPerMTok).toBe(0.4);
  });

  test("parses omitted cached price as null", () => {
    const noCached = `<tr className="pricing-row pricing-row-window pricing-row-model-first" aria-label="Some Model Flex pricing: input $0.10, output $0.50 per 1M tokens.">
          <td className="pricing-cell pricing-cell-model">
            <span className="cap-slug-text" title="org/some-model">
              <code>org/some-model</code>
            </span>
          </td>
        </tr>`;
    const map = parsePricingFromJsx(noCached);
    const prices = map.get("org/some-model")!;
    expect(prices.length).toBe(1);
    expect(prices[0]!.cachedInputPerMTok).toBeNull();
    expect(prices[0]!.inputPerMTok).toBe(0.1);
    expect(prices[0]!.outputPerMTok).toBe(0.5);
  });

  test("skips rows before any model slug appears", () => {
    const noSlug = `<tr className="pricing-row pricing-row-window" aria-label="Ghost Model Flex pricing: input $0.10, cached $0.05, output $0.50 per 1M tokens.">
          <td className="pricing-cell pricing-cell-window">Flex</td>
        </tr>`;
    const map = parsePricingFromJsx(noSlug);
    expect(map.size).toBe(0);
  });

  test("returns empty map for content with no pricing rows", () => {
    const map = parsePricingFromJsx("<p>Hello world</p>");
    expect(map.size).toBe(0);
  });

  test("returns empty map for empty string", () => {
    const map = parsePricingFromJsx("");
    expect(map.size).toBe(0);
  });

  test("snapshot: full realistic pricing page produces stable output", () => {
    const map = parsePricingFromJsx(FULL_PRICING_PAGE);
    const entries = [...map.entries()].map(([id, prices]) => ({
      modelId: id,
      prices,
    }));
    expect(entries).toMatchSnapshot("full-page-pricing");
  });
});

describe("scrapePricing", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches the pricing page and parses deterministically", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(FULL_PRICING_PAGE, { status: 200 })),
    ) as any;

    const map = await scrapePricing();
    expect(map.size).toBe(3);
    expect(map.get("zai-org/GLM-5.2-FP8")!.length).toBe(4);
    expect(map.get("openai/gpt-oss-120b")!.length).toBe(2);
    expect(map.get("Qwen/Qwen3.6-35B-A3B")!.length).toBe(1);
  });

  test("throws on fetch failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as any;

    expect(scrapePricing()).rejects.toThrow("Failed to fetch");
  });
});
