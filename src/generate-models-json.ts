/**
 * Generate a complete `models.json` for the pi coding agent from the
 * proxy's REST API — no DB or scraper dependencies.
 *
 * Usage: bun run src/generate-models-json.ts [options]
 *
 * Options:
 *   --base-url <url>    Proxy base URL (default: http://localhost:4000/v1)
 *   --output <path>     Output file path (default: stdout)
 *   --smoke-test        Run a smoke test for each preset + thinking level
 *                        via /v1/chat/completions (default: off)
 *
 * Output format follows pi's models.json spec:
 * https://pi.dev/docs/latest/models
 */
import { COMPLETION_WINDOWS } from "./completion-window.ts";
import { WINDOW_PROVIDER_NAMES } from "./constants.ts";
import type { CompletionWindow, SamplingPresetInput } from "./types.ts";
import type { PriceWire, PresetWire } from "./models-meta.ts";
import {
  smokeTestPresets,
  smokeTestWindowCompatibility,
  chatCompletionsUrlForWindow,
  pickBestWindow,
  smokeTimeoutForWindow,
} from "./research-models.ts";
import { config } from "./config.ts";
import { mapSettledWithLimit } from "./concurrency.ts";

// ─── CLI arg parsing ────────────────────────────────────────────────────────

interface CliOptions {
  baseUrl: string;
  output: string | null; // null = stdout
  smokeTest: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: "http://localhost:4000/v1",
    output: null,
    smokeTest: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i]!;
    } else if (arg === "--output" && args[i + 1]) {
      opts.output = args[++i]!;
    } else if (arg === "--smoke-test") {
      opts.smokeTest = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run src/generate-models-json.ts [options]

Options:
  --base-url <url>    Proxy base URL (default: http://localhost:4000/v1)
  --output <path>     Output file path (default: stdout)
  --smoke-test        Run a smoke test for each preset + thinking level
  -h, --help          Show this help

Generates a models.json for the pi coding agent. All model metadata is
fetched from the proxy's /v1/models endpoint — no DB or scraper needed.

Each completion window (asap, priority, standard, flex) becomes a separate
provider section. Models with multiple sampling presets are broken out by
name using the convention: "model-id::preset-name" for non-default presets.

With --smoke-test, each preset (and one thinking level for reasoning models)
is tested by sending a unique arithmetic prompt (e.g. "What is 42 + 17?
Reply with just the number.") through /v1/chat/completions. Each call uses
different random numbers to defeat the proxy's dedup cache and force real
inference. Failed
presets and thinking levels are filtered from the output, matching the
behavior of model research.

No apiKey is included — add your own to the output.`);
      process.exit(0);
    }
  }

  return opts;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** pi models.json model entry */
interface PiModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

/** pi models.json provider section */
interface PiProvider {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: PiModelEntry[];
}

/** pi models.json top-level shape */
interface PiModelsJson {
  providers: Record<string, PiProvider>;
}

/** Resolved metadata for a single model */
export interface ModelData {
  modelId: string;
  contextSize: number | null;
  description: string | null;
  supportsImage: boolean;
  reasoning: boolean;
  thinkingLevelMap: Record<string, string | null> | null;
  samplingPresets: PresetWire[];
  pricesByWindow: Map<CompletionWindow, PriceWire>;
  supportedWindows: Set<CompletionWindow>;
}

// ─── Data loading ───────────────────────────────────────────────────────────

/**
 * Fetch enriched model metadata from the proxy's /v1/models REST endpoint
 * and convert each entry to the ModelData shape needed for models.json
 * generation. No DB access required — all data comes from the API.
 */
async function fetchModelMetaFromApi(
  baseUrl: string,
): Promise<Map<string, ModelData>> {
  const url = baseUrl.replace(/\/v1\/?$/, "");
  const res = await fetch(`${url}/v1/models`);
  if (!res.ok) {
    throw new Error(
      `Proxy returned ${res.status} ${res.statusText} for /v1/models`,
    );
  }
  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
  };

  const map = new Map<string, ModelData>();
  for (const entry of body.data ?? []) {
    const data = restShapeToModelData(entry);
    map.set(data.modelId, data);
  }
  return map;
}

/**
 * Convert a single model entry from the /v1/models response (OpenRouter
 * snake_case shape) into the ModelData shape used by models.json generation.
 */
export function restShapeToModelData(
  entry: Record<string, unknown>,
): ModelData {
  const modelId = typeof entry.id === "string" ? entry.id : "unknown";
  const contextSize =
    typeof entry.context_length === "number" ? entry.context_length : null;
  const description =
    typeof entry.description === "string" ? entry.description : null;
  const supportsImage = entry.supports_image === true;
  const reasoning = entry.reasoning === true;

  // thinkingLevelMap
  let thinkingLevelMap: Record<string, string | null> | null = null;
  if (
    typeof entry.thinking_level_map === "object" &&
    entry.thinking_level_map !== null &&
    !Array.isArray(entry.thinking_level_map)
  ) {
    thinkingLevelMap = entry.thinking_level_map as Record<
      string,
      string | null
    >;
  }

  // samplingPresets
  let samplingPresets: PresetWire[] = [];
  if (Array.isArray(entry.x_sampling_presets)) {
    samplingPresets = entry.x_sampling_presets
      .filter(
        (p: unknown): p is Record<string, unknown> =>
          typeof p === "object" && p !== null,
      )
      .map((p) => ({
        name: typeof p.name === "string" ? p.name : "default",
        description: typeof p.description === "string" ? p.description : "",
        params:
          typeof p.params === "object" &&
          p.params !== null &&
          !Array.isArray(p.params)
            ? (p.params as Record<string, number | string | boolean>)
            : {},
      }));
  }
  // Fallback: if no x_sampling_presets but default_parameters exists, create one
  if (samplingPresets.length === 0 && entry.default_parameters) {
    const params =
      typeof entry.default_parameters === "object" &&
      entry.default_parameters !== null &&
      !Array.isArray(entry.default_parameters)
        ? (entry.default_parameters as Record<
            string,
            number | string | boolean
          >)
        : {};
    samplingPresets = [
      { name: "default", description: "Default settings", params },
    ];
  }

  // pricesByWindow
  const pricesByWindow = new Map<CompletionWindow, PriceWire>();
  if (Array.isArray(entry.x_pricing_by_completion_window)) {
    for (const p of entry.x_pricing_by_completion_window) {
      if (typeof p !== "object" || p === null) continue;
      const price = p as Record<string, unknown>;
      const window = price.completion_window ?? price.completionWindow;
      if (
        typeof window !== "string" ||
        (window !== "asap" &&
          window !== "priority" &&
          window !== "standard" &&
          window !== "flex")
      ) {
        continue;
      }
      const inputPerMTok =
        typeof price.input_per_mtok === "number"
          ? price.input_per_mtok
          : typeof price.inputPerMTok === "number"
            ? price.inputPerMTok
            : 0;
      const cachedInputPerMTok =
        typeof price.cached_input_per_mtok === "number"
          ? price.cached_input_per_mtok
          : typeof price.cachedInputPerMTok === "number"
            ? price.cachedInputPerMTok
            : null;
      const outputPerMTok =
        typeof price.output_per_mtok === "number"
          ? price.output_per_mtok
          : typeof price.outputPerMTok === "number"
            ? price.outputPerMTok
            : 0;
      const currency =
        typeof price.currency === "string" ? price.currency : "USD";
      pricesByWindow.set(window as CompletionWindow, {
        completionWindow: window as CompletionWindow,
        inputPerMTok,
        cachedInputPerMTok,
        outputPerMTok,
        currency,
      });
    }
  }

  // supportedWindows — from API response
  let supportedWindows: Set<CompletionWindow> = new Set();
  if (Array.isArray(entry.x_supported_windows)) {
    for (const w of entry.x_supported_windows) {
      if (
        typeof w === "string" &&
        (w === "asap" || w === "priority" || w === "standard" || w === "flex")
      ) {
        supportedWindows.add(w);
      }
    }
  }

  return {
    modelId,
    contextSize,
    description,
    supportsImage,
    reasoning,
    thinkingLevelMap,
    samplingPresets,
    pricesByWindow,
    supportedWindows,
  };
}

// ─── Build pi model entries ─────────────────────────────────────────────────

/**
 * Infer the thinkingFormat compat value based on the model's org/family.
 * See pi docs: https://pi.dev/docs/latest/models#openai-compatibility
 */
export function inferThinkingFormat(modelId: string): string | undefined {
  if (modelId.startsWith("zai-org/")) return "zai";
  if (modelId.startsWith("deepseek-ai/")) return "deepseek";
  if (modelId.startsWith("Qwen/")) return "qwen";
  return undefined;
}

/**
 * Build a human-readable name from the model ID and optional preset qualifier.
 * E.g. "moonshotai/Kimi-K2.5" → "Kimi K2.5"
 * Plus preset name: "Kimi K2.5 (creative)"
 */
export function buildModelName(modelId: string, presetName?: string): string {
  // Extract the short name from the model ID (everything after the /)
  const shortId = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;

  // Convert kebab-case / dots to title case with spaces
  let name = shortId
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  if (presetName && presetName !== "default") {
    name += ` (${presetName})`;
  }

  return name;
}

/**
 * Build a pi model entry for a given model, preset, and completion window.
 */
export function buildPiModelEntry(
  data: ModelData,
  preset: PresetWire,
  price: PriceWire | null,
): PiModelEntry {
  const isDefaultPreset = preset.name === "default";
  const entry: PiModelEntry = {
    id: isDefaultPreset ? data.modelId : `${data.modelId}::${preset.name}`,
    name: buildModelName(
      data.modelId,
      isDefaultPreset ? undefined : preset.name,
    ),
  };

  // Reasoning
  if (data.reasoning) {
    entry.reasoning = true;
    if (data.thinkingLevelMap) {
      entry.thinkingLevelMap = data.thinkingLevelMap;
    }
  }

  // Input types
  if (data.supportsImage) {
    entry.input = ["text", "image"];
  }

  // Context window
  if (data.contextSize !== null) {
    entry.contextWindow = data.contextSize;
  }

  // Max tokens — try to extract from preset params, otherwise use a reasonable default
  const maxTokens =
    typeof preset.params.max_tokens === "number"
      ? preset.params.max_tokens
      : typeof preset.params.max_completion_tokens === "number"
        ? preset.params.max_completion_tokens
        : undefined;
  if (maxTokens !== undefined) {
    entry.maxTokens = maxTokens;
  }

  // Cost — only include when pricing data is available
  if (price) {
    entry.cost = {
      input: price.inputPerMTok,
      output: price.outputPerMTok,
      cacheRead: price.cachedInputPerMTok ?? 0,
      cacheWrite: 0,
    };
  }

  // Compat — for Sail's OpenAI-compatible endpoint, we set defaults
  // that work with most models served there.
  const compat: Record<string, unknown> = {};

  if (data.reasoning) {
    // Reasoning models may need developer role and reasoning effort
    compat.supportsDeveloperRole = true;
    compat.supportsReasoningEffort = true;
    const thinkingFormat = inferThinkingFormat(data.modelId);
    if (thinkingFormat) {
      compat.thinkingFormat = thinkingFormat;
    }
  } else {
    // Non-reasoning models served by Sail typically don't support developer
    // role or reasoning effort parameters
    compat.supportsDeveloperRole = false;
    compat.supportsReasoningEffort = false;
  }

  entry.compat = compat;

  return entry;
}

/**
 * Build a provider section for a given completion window.
 * Only includes models that have pricing for that window.
 */
export function buildProvider(
  window: CompletionWindow,
  modelsData: Map<string, ModelData>,
  baseUrl: string,
): PiProvider | null {
  const entries: PiModelEntry[] = [];

  // Build the base URL for this window. Normalize first by stripping any
  // trailing "/v1" and slashes so the result is correct whether the caller
  // passed ".../v1" (e.g. http://localhost:4000/v1) or a bare host (e.g.
  // https://llm3.cricket.routers.stonelinks.org).
  //   standard (default): {host}/v1
  //   others:             {host}/{window}/v1
  const stripped = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const providerBaseUrl =
    window === "standard" ? `${stripped}/v1` : `${stripped}/${window}/v1`;

  for (const data of [...modelsData.values()]) {
    // Skip models that don't support this window.
    // If supportedWindows is empty (not yet tested), include by default.
    if (data.supportedWindows.size > 0 && !data.supportedWindows.has(window)) {
      continue;
    }

    const price = data.pricesByWindow.get(window) ?? null;

    if (data.samplingPresets.length === 0) {
      // No presets — create a single entry with default values
      const defaultPreset: PresetWire = {
        name: "default",
        description: "Default settings",
        params: {},
      };
      entries.push(buildPiModelEntry(data, defaultPreset, price));
    } else {
      // Create one entry per preset
      for (const preset of data.samplingPresets) {
        entries.push(buildPiModelEntry(data, preset, price));
      }
    }
  }

  if (entries.length === 0) return null;

  return {
    baseUrl: providerBaseUrl,
    api: "openai-completions",
    apiKey: "test",
    models: entries,
  };
}

// ─── Smoke test ─────────────────────────────────────────────────────────────

/** Smoke test result row for display */
interface SmokeRow {
  modelId: string;
  presetName: string;
  thinkingLevel: string | null;
  ok: boolean;
  error?: string;
}

function printSmokeTestSummary(results: SmokeRow[]): void {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("");
  console.log("========================================");
  console.log("Smoke Test Results");
  console.log("========================================");

  // Print table header
  console.log(
    `${"Model".padEnd(42)} ${"Preset".padEnd(14)} ${"Thinking".padEnd(10)} ${"Status".padEnd(8)}`,
  );
  console.log("-".repeat(78));

  for (const r of results) {
    const model =
      r.modelId.length > 40 ? r.modelId.slice(0, 38) + ".." : r.modelId;
    const thinking = r.thinkingLevel ?? "—";
    const statusIcon = r.ok ? "✓" : "✗";

    console.log(
      `${model.padEnd(42)} ${r.presetName.padEnd(14)} ${thinking.padEnd(10)} ${statusIcon} ${r.ok ? "pass" : "fail"}`,
    );

    if (r.error) {
      console.log(`  ↳ ${r.error}`);
    }
  }

  console.log("-".repeat(78));
  console.log(
    `Total: ${results.length} | ✓ ${passed.length} passed | ✗ ${failed.length} failed`,
  );
  console.log("========================================");
}

/**
 * Compute the chat completions URL from the user-supplied base URL.
 * Input:  http://host:4000/v1  (or http://host:4000)
 * Output: http://host:4000/v1/chat/completions
 */
function chatCompletionsUrl(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return `${stripped}/v1/chat/completions`;
}

/**
 * Smoke test a single model: window compatibility first, then presets +
 * thinking levels through a supported window. Mutates `data` in-place to
 * remove failed presets / disable failed thinking levels, and returns the
 * display rows for that model.
 *
 * Output is buffered into a single block so concurrent models don't
 * interleave their log lines.
 */
async function smokeTestOneModel(
  modelId: string,
  data: ModelData,
  strippedBaseUrl: string,
): Promise<SmokeRow[]> {
  const rows: SmokeRow[] = [];
  const out: string[] = [];

  // ── Phase 1: Window compatibility ────────────────────────────────
  // Must run FIRST so we know which windows the model supports — preset
  // smoke tests need to route through a supported window.
  const compat = await smokeTestWindowCompatibility(modelId, strippedBaseUrl);
  data.supportedWindows = compat.supported;
  out.push(
    `  windows: ${compat.supported.size > 0 ? [...compat.supported].join(", ") : "(none)"}`,
  );
  if (compat.timedOut.size > 0) {
    out.push(
      `  windows unconfirmed (timeout): ${[...compat.timedOut].join(", ")}`,
    );
  }

  // ── Phase 2: Preset + thinking level smoke tests ────────────────
  // Convert PresetWire[] to SamplingPresetInput[] for smokeTestPresets
  const presets: SamplingPresetInput[] = data.samplingPresets.map((p) => ({
    name: p.name,
    description: p.description,
    params: p.params,
  }));

  if (presets.length === 0) {
    out.push("  no presets, skipping");
    console.log(`${modelId}:\n${out.join("\n")}`);
    return rows;
  }

  const bestWindow = pickBestWindow(data.supportedWindows);
  const completionsUrl = chatCompletionsUrlForWindow(
    strippedBaseUrl,
    bestWindow,
  );
  out.push(
    `  testing ${presets.length} preset${presets.length > 1 ? "s" : ""} (window=${bestWindow})`,
  );

  const results = await smokeTestPresets(
    modelId,
    presets,
    data.thinkingLevelMap,
    completionsUrl,
    smokeTimeoutForWindow(bestWindow),
  );

  // Collect results for display
  for (const r of results) {
    rows.push({
      modelId,
      presetName: r.presetName,
      thinkingLevel: r.thinkingLevel,
      ok: r.ok,
      error: r.error,
    });
  }

  // Filter out presets that failed the base-param smoke test
  const failedPresetNames = new Set<string>();
  const failedThinkingLevels = new Set<string>();

  for (const sr of results) {
    if (sr.ok) continue;
    if (sr.thinkingLevel !== null) {
      failedThinkingLevels.add(sr.thinkingLevel);
      out.push(
        `  ✗ preset="${sr.presetName}" thinkingLevel=${sr.thinkingLevel} — ${sr.error}`,
      );
    } else {
      failedPresetNames.add(sr.presetName);
      out.push(`  ✗ preset="${sr.presetName}" base params — ${sr.error}`);
    }
  }

  // Remove failed presets from the model data
  if (failedPresetNames.size > 0) {
    data.samplingPresets = data.samplingPresets.filter(
      (p) => !failedPresetNames.has(p.name),
    );
    out.push(
      `  removed ${failedPresetNames.size} failed preset(s): ${[...failedPresetNames].join(", ")}`,
    );
  }

  // Disable failed thinking levels
  if (data.thinkingLevelMap && failedThinkingLevels.size > 0) {
    for (const level of failedThinkingLevels) {
      if (level in data.thinkingLevelMap) {
        data.thinkingLevelMap[level] = null;
        out.push(`  disabled thinking level "${level}"`);
      }
    }
  }

  const passCount = results.filter((r) => r.ok).length;
  out.push(`  ✓ ${passCount}/${results.length} passed`);
  console.log(`${modelId}:\n${out.join("\n")}`);
  return rows;
}

/**
 * Run smoke tests for all models, filtering out failed presets and thinking
 * levels from the metaMap in-place. Returns the display rows for the summary.
 *
 * Models are smoke tested through a bounded worker pool
 * (`config.research.maxConcurrent`), mirroring `researchAndUpsertMany`
 * (see graphql/research-models-runner.ts).
 *
 * @param metaMap          Model data map (mutated in-place to remove failed presets)
 * @param proxyBaseUrl     Proxy base URL (e.g. http://localhost:4000/v1)
 */
async function runSmokeTests(
  metaMap: Map<string, ModelData>,
  proxyBaseUrl: string,
): Promise<SmokeRow[]> {
  const modelIds = [...metaMap.keys()];
  const strippedBaseUrl = proxyBaseUrl
    .replace(/\/v1\/?$/, "")
    .replace(/\/+$/, "");

  const limit = config.research.maxConcurrent;
  console.log(
    `Smoke testing ${modelIds.length} models (up to ${limit} at a time) ...\n`,
  );

  const settled = await mapSettledWithLimit(modelIds, limit, (modelId) =>
    smokeTestOneModel(modelId, metaMap.get(modelId)!, strippedBaseUrl),
  );

  const rows: SmokeRow[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      rows.push(...result.value);
    } else {
      const modelId = modelIds[i]!;
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.warn(`✗ ${modelId}: smoke test errored — ${msg}`);
    }
  }

  return rows;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Health check
  const healthUrl = opts.baseUrl.replace(/\/v1\/?$/, "") + "/v1/models";
  console.log(`Checking proxy at ${healthUrl} ...`);
  try {
    const res = await fetch(healthUrl);
    if (!res.ok) throw new Error(`${res.status}`);
    console.log("  ✓ Proxy is reachable\n");
  } catch {
    console.error(`ERROR: Proxy is not reachable at ${healthUrl}`);
    console.error("Start the proxy first with: bin/dev  or  bin/run");
    process.exit(1);
  }

  // Load enriched model metadata from the proxy's REST API
  console.log("Loading model metadata from API ...");
  let metaMap: Map<string, ModelData>;
  try {
    metaMap = await fetchModelMetaFromApi(opts.baseUrl);
    console.log(`  ✓ Loaded metadata for ${metaMap.size} models\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }

  // Smoke test — run before building the output so failed presets/levels
  // are filtered out of the generated models.json
  if (opts.smokeTest) {
    console.log("Running smoke tests ...\n");
    const smokeRows = await runSmokeTests(metaMap, opts.baseUrl);

    printSmokeTestSummary(smokeRows);

    const hasFailures = smokeRows.some((r) => !r.ok);
    if (hasFailures) {
      console.log(
        "\nSome smoke tests failed — the corresponding presets/thinking levels",
      );
      console.log("have been removed from the generated output.\n");
    }
  }

  // Build providers
  console.log("Building models.json ...");
  const output: PiModelsJson = { providers: {} };

  // Also add a top-level "sail" provider that maps to standard (no prefix)
  // for backward compatibility
  let hasStandard = false;

  for (const window of COMPLETION_WINDOWS) {
    const provider = buildProvider(window, metaMap, opts.baseUrl);
    if (!provider) continue;

    const providerName = WINDOW_PROVIDER_NAMES[window];
    output.providers[providerName] = provider;

    if (window === "standard") {
      hasStandard = true;
      // Also add as "sail" for convenience
      output.providers["sail"] = {
        ...provider,
      };
    }
  }

  if (!hasStandard && output.providers["sail"] === undefined) {
    // No standard window models — still create sail provider pointing at default
    const defaultProvider = buildProvider("standard", metaMap, opts.baseUrl);
    if (defaultProvider) {
      output.providers["sail"] = defaultProvider;
    }
  }

  // Write output
  const jsonStr = JSON.stringify(output, null, 2);

  if (opts.output) {
    await Bun.write(opts.output, jsonStr);
    console.log(`  ✓ Written to ${opts.output}\n`);
  } else {
    console.log(jsonStr);
  }
}

// Only run when invoked directly
if (import.meta.main) {
  main();
}
