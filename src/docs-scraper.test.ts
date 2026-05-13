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

/** A pricing row with all 4 windows (standard, priority, flex, asap) */
const PRICING_ROW_FULL = `<tr className="pricing-row">
          <td className="pricing-cell pricing-cell-model" style={{ width: "18.0rem", minWidth: "18.0rem" }}>
            <div className="pricing-cell-model-inner">
              <span className="cap-logo" data-org="moonshot" role="img" aria-label="Moonshot AI" />
              <div className="pricing-model-meta">
                <div className="cap-model-name">Kimi K2.5</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="moonshotai/Kimi-K2.5">
                    <code>moonshotai/Kimi-K2.5</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Input">
            <div className="price-stack">
              <span className="price-window" data-window="standard">Standard</span>
              <span className="price-amount" data-window="standard">
                <span className="price-currency" aria-hidden="true">$</span>0.20
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="priority">Priority</span>
              <span className="price-amount" data-window="priority">
                <span className="price-currency" aria-hidden="true">$</span>0.25
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.16
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.60
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Cached">
            <div className="price-stack">
              <span className="price-window" data-window="standard">Standard</span>
              <span className="price-amount" data-window="standard">
                <span className="price-currency" aria-hidden="true">$</span>0.10
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="priority">Priority</span>
              <span className="price-amount" data-window="priority">
                <span className="price-currency" aria-hidden="true">$</span>0.15
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.05
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.10
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Output">
            <div className="price-stack">
              <span className="price-window" data-window="standard">Standard</span>
              <span className="price-amount" data-window="standard">
                <span className="price-currency" aria-hidden="true">$</span>1.20
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="priority">Priority</span>
              <span className="price-amount" data-window="priority">
                <span className="price-currency" aria-hidden="true">$</span>1.80
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.80
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>3.00
              </span>
            </div>
          </td>
        </tr>`;

/** A pricing row with only 2 windows (flex, asap) */
const PRICING_ROW_PARTIAL = `<tr className="pricing-row">
          <td className="pricing-cell pricing-cell-model" style={{ width: "18.0rem", minWidth: "18.0rem" }}>
            <div className="pricing-cell-model-inner">
              <span className="cap-logo" data-org="deepseek" role="img" aria-label="DeepSeek" />
              <div className="pricing-model-meta">
                <div className="cap-model-name">DeepSeek V3.2</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="deepseek-ai/DeepSeek-V3.2">
                    <code>deepseek-ai/DeepSeek-V3.2</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Input">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.04
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.56
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Cached">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.01
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.28
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Output">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.25
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>1.68
              </span>
            </div>
          </td>
        </tr>`;

/** A pricing row with 2 models (MiniMax + Gemma in the same <tr>) */
const PRICING_ROW_MULTI_MODEL = `<tr className="pricing-row">
          <td className="pricing-cell pricing-cell-model" style={{ width: "18.0rem", minWidth: "18.0rem" }}>
            <div className="pricing-cell-model-inner">
              <div className="pricing-model-meta">
                <div className="cap-model-name">MiniMax M2.7</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="MiniMaxAI/MiniMax-M2.7">
                    <code>MiniMaxAI/MiniMax-M2.7</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Input">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.06
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.30
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Cached">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.015
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.06
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Output">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.30
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>1.20
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-model" style={{ width: "18.0rem", minWidth: "18.0rem" }}>
            <div className="pricing-cell-model-inner">
              <div className="pricing-model-meta">
                <div className="cap-model-name">Gemma 4 31B IT</div>
                <div className="cap-slug-actions">
                  <span className="cap-slug-text" title="google/gemma-4-31B-it">
                    <code>google/gemma-4-31B-it</code>
                  </span>
                </div>
              </div>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Input">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.06
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.14
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Cached">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.02
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.07
              </span>
            </div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Output">
            <div className="price-stack">
              <span className="price-window" data-window="flex">Flex</span>
              <span className="price-amount" data-window="flex">
                <span className="price-currency" aria-hidden="true">$</span>0.30
              </span>
            </div>
            <div className="price-stack">
              <span className="price-window" data-window="asap">ASAP</span>
              <span className="price-amount" data-window="asap">
                <span className="price-currency" aria-hidden="true">$</span>0.40
              </span>
            </div>
          </td>
        </tr>`;

/** Full realistic pricing page */
const FULL_PRICING_PAGE = `# Pricing

> Per-token pricing for Sail inference

<div className="pricing-table-page">
${PRICING_ROW_FULL}
${PRICING_ROW_PARTIAL}
${PRICING_ROW_MULTI_MODEL}
</div>`;

// ─── Pricing parser tests ─────────────────────────────────────────────────

describe("parsePricingFromJsx", () => {
  test("parses a model with all 4 windows", () => {
    const map = parsePricingFromJsx(PRICING_ROW_FULL);
    expect(map.size).toBe(1);
    const prices = map.get("moonshotai/Kimi-K2.5")!;
    expect(prices.length).toBe(4);

    const standard = prices.find((p) => p.completionWindow === "standard")!;
    expect(standard.inputPerMTok).toBe(0.2);
    expect(standard.cachedInputPerMTok).toBe(0.1);
    expect(standard.outputPerMTok).toBe(1.2);

    const flex = prices.find((p) => p.completionWindow === "flex")!;
    expect(flex.inputPerMTok).toBe(0.16);
    expect(flex.cachedInputPerMTok).toBe(0.05);
    expect(flex.outputPerMTok).toBe(0.8);

    const asap = prices.find((p) => p.completionWindow === "asap")!;
    expect(asap.inputPerMTok).toBe(0.6);
    expect(asap.cachedInputPerMTok).toBe(0.1);
    expect(asap.outputPerMTok).toBe(3.0);
  });

  test("parses a model with only 2 windows (flex, asap)", () => {
    const map = parsePricingFromJsx(PRICING_ROW_PARTIAL);
    expect(map.size).toBe(1);
    const prices = map.get("deepseek-ai/DeepSeek-V3.2")!;
    expect(prices.length).toBe(2);

    const flex = prices.find((p) => p.completionWindow === "flex")!;
    expect(flex.inputPerMTok).toBe(0.04);
    expect(flex.cachedInputPerMTok).toBe(0.01);
    expect(flex.outputPerMTok).toBe(0.25);

    const asap = prices.find((p) => p.completionWindow === "asap")!;
    expect(asap.inputPerMTok).toBe(0.56);
    expect(asap.cachedInputPerMTok).toBe(0.28);
    expect(asap.outputPerMTok).toBe(1.68);
  });

  test("parses a row with 2 models (MiniMax + Gemma)", () => {
    const map = parsePricingFromJsx(PRICING_ROW_MULTI_MODEL);
    expect(map.size).toBe(2);

    const minimax = map.get("MiniMaxAI/MiniMax-M2.7")!;
    expect(minimax.length).toBe(2);
    const mmFlex = minimax.find((p) => p.completionWindow === "flex")!;
    expect(mmFlex.inputPerMTok).toBe(0.06);
    expect(mmFlex.cachedInputPerMTok).toBe(0.015);
    expect(mmFlex.outputPerMTok).toBe(0.3);

    const gemma = map.get("google/gemma-4-31B-it")!;
    expect(gemma.length).toBe(2);
    const gFlex = gemma.find((p) => p.completionWindow === "flex")!;
    expect(gFlex.inputPerMTok).toBe(0.06);
    expect(gFlex.cachedInputPerMTok).toBe(0.02);
    expect(gFlex.outputPerMTok).toBe(0.3);
  });

  test("skips rows without valid titles", () => {
    const noTitle = `<tr className="pricing-row">
          <td className="pricing-cell pricing-cell-model">
            <div className="cap-model-name">No Slug Model</div>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Input">
            <span className="price-amount" data-window="flex">
              <span className="price-currency" aria-hidden="true">$</span>0.10
            </span>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Cached">
            <span className="price-amount" data-window="flex">
              <span className="price-currency" aria-hidden="true">$</span>0.05
            </span>
          </td>
          <td className="pricing-cell pricing-cell-price" data-axis="Output">
            <span className="price-amount" data-window="flex">
              <span className="price-currency" aria-hidden="true">$</span>0.50
            </span>
          </td>
        </tr>`;
    const map = parsePricingFromJsx(noTitle);
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
    expect(map.size).toBe(4);
    expect(map.get("moonshotai/Kimi-K2.5")!.length).toBe(4);
    expect(map.get("deepseek-ai/DeepSeek-V3.2")!.length).toBe(2);
    expect(map.get("MiniMaxAI/MiniMax-M2.7")!.length).toBe(2);
    expect(map.get("google/gemma-4-31B-it")!.length).toBe(2);
  });

  test("throws on fetch failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as any;

    expect(scrapePricing()).rejects.toThrow("Failed to fetch");
  });
});
