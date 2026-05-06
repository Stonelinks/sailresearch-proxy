/**
 * Generate a complete `models.json` for the pi coding agent from researched
 * model metadata in the database and scraped Sail docs data.
 *
 * Usage: bun run src/generate-models-json.ts [options]
 *
 * Options:
 *   --base-url <url>    Proxy base URL (default: http://localhost:4000/v1)
 *   --output <path>     Output file path (default: stdout)
 *   --smoke-test        Run a smoke test for each model entry (default: off)
 *   --sequential        Process models one at a time instead of parallel
 *
 * Output format follows pi's models.json spec:
 * https://pi.dev/docs/latest/models
 */
import { prisma } from "./db.ts";
import { COMPLETION_WINDOWS } from "./completion-window.ts";
import { WINDOW_PROVIDER_NAMES } from "./constants.ts";
import type { CompletionWindow } from "./types.ts";
import { scrapeImageCapabilities, scrapePricing } from "./docs-scraper.ts";
import type { ModelPriceInput } from "./types.ts";
import type { PriceWire, PresetWire } from "./models-meta.ts";
import { runPiChat } from "./pi-session.ts";

// ─── CLI arg parsing ────────────────────────────────────────────────────────

interface CliOptions {
  baseUrl: string;
  output: string | null; // null = stdout
  smokeTest: boolean;
  sequential: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: "http://localhost:4000/v1",
    output: null,
    smokeTest: false,
    sequential: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i]!;
    } else if (arg === "--output" && args[i + 1]) {
      opts.output = args[++i]!;
    } else if (arg === "--smoke-test") {
      opts.smokeTest = true;
    } else if (arg === "--sequential") {
      opts.sequential = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run src/generate-models-json.ts [options]

Options:
  --base-url <url>    Proxy base URL (default: http://localhost:4000/v1)
  --output <path>     Output file path (default: stdout)
  --smoke-test        Run a smoke test for each model entry
  --sequential        Process models one at a time
  -h, --help          Show this help

Generates a models.json for the pi coding agent. Each completion window
(asap, priority, standard, flex) becomes a separate provider section.
Models with multiple sampling presets are broken out by name using the
convention: "model-id::preset-name" for non-default presets.

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
}

// ─── Data loading ───────────────────────────────────────────────────────────

async function fetchModelList(baseUrl: string): Promise<string[]> {
  // Strip trailing /v1 if present so we can consistently append /v1/models
  const url = baseUrl.replace(/\/v1\/?$/, "");
  const res = await fetch(`${url}/v1/models`);
  if (!res.ok) {
    throw new Error(
      `Proxy returned ${res.status} ${res.statusText} for /v1/models`,
    );
  }
  const body = (await res.json()) as { data: Array<{ id: string }> };
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error("No models found in /v1/models response");
  }
  return body.data.map((m) => m.id);
}

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

  return {
    modelId,
    contextSize,
    description,
    supportsImage,
    reasoning,
    thinkingLevelMap,
    samplingPresets,
    pricesByWindow,
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

  // Build the base URL for this window.
  // For "standard" (the default), use the base URL as-is.
  // For others, inject the window prefix.
  let providerBaseUrl: string;

  if (window === "standard") {
    // Standard is the default — no prefix needed
    providerBaseUrl = baseUrl.replace(/\/+$/, "");
  } else {
    // e.g. http://localhost:4000/v1 → http://localhost:4000/asap/v1
    // Strip /v1 from the end, add /{window}/v1
    const stripped = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    providerBaseUrl = `${stripped}/${window}/v1`;
  }

  for (const data of [...modelsData.values()]) {
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

interface SmokeTestResult {
  providerName: string;
  modelId: string;
  preset: string;
  status: "pass" | "fail" | "timeout";
  error?: string;
  tokenCount?: number;
  durationMs?: number;
}

/**
 * Run a smoke test by invoking the pi SDK with the given provider/model
 * and a simple "hi" prompt. Checks that tokens come back.
 */
async function smokeTestEntry(
  providerName: string,
  modelId: string,
  preset: string,
): Promise<SmokeTestResult> {
  const start = Date.now();

  try {
    const output = await runPiChat(providerName, modelId, "hi");
    const durationMs = Date.now() - start;

    // Check that we got some output
    const trimmed = output.trim();
    if (trimmed.length === 0) {
      return {
        providerName,
        modelId,
        preset,
        status: "fail",
        error: "empty output",
        durationMs,
      };
    }

    // Rough token count estimate (words / 0.75 ≈ tokens)
    const tokenCount = Math.round(trimmed.split(/\s+/).length / 0.75);

    return {
      providerName,
      modelId,
      preset,
      status: "pass",
      tokenCount,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return {
        providerName,
        modelId,
        preset,
        status: "timeout",
        error: msg,
        durationMs,
      };
    }
    return {
      providerName,
      modelId,
      preset,
      status: "fail",
      error: msg,
      durationMs,
    };
  }
}

function printSmokeTestSummary(results: SmokeTestResult[]): void {
  const passed = results.filter((r) => r.status === "pass");
  const failed = results.filter((r) => r.status === "fail");
  const timedOut = results.filter((r) => r.status === "timeout");

  console.log("");
  console.log("========================================");
  console.log("Smoke Test Results");
  console.log("========================================");

  // Print table header
  console.log(
    `${"Provider".padEnd(16)} ${"Model".padEnd(40)} ${"Preset".padEnd(14)} ${"Status".padEnd(8)} ${"Tokens".padEnd(8)} ${"Time".padEnd(8)}`,
  );
  console.log("-".repeat(96));

  for (const r of results) {
    const model =
      r.modelId.length > 38 ? r.modelId.slice(0, 36) + ".." : r.modelId;
    const tokens = r.tokenCount !== undefined ? String(r.tokenCount) : "—";
    const time = r.durationMs !== undefined ? `${r.durationMs}ms` : "—";
    const statusIcon =
      r.status === "pass" ? "✓" : r.status === "timeout" ? "⏱" : "✗";

    console.log(
      `${r.providerName.padEnd(16)} ${model.padEnd(40)} ${r.preset.padEnd(14)} ${statusIcon} ${r.status.padEnd(6)} ${tokens.padEnd(8)} ${time.padEnd(8)}`,
    );

    if (r.error) {
      console.log(`  ↳ ${r.error}`);
    }
  }

  console.log("-".repeat(96));
  console.log(
    `Total: ${results.length} | ✓ ${passed.length} passed | ✗ ${failed.length} failed | ⏱ ${timedOut.length} timed out`,
  );
  console.log("========================================");
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

  // Fetch model list from proxy
  console.log("Fetching model list ...");
  let modelIds: string[];
  try {
    modelIds = await fetchModelList(opts.baseUrl);
    console.log(`  ✓ Found ${modelIds.length} models\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
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

  // Smoke test
  if (opts.smokeTest) {
    console.log("Running smoke tests ...\n");
    const results: SmokeTestResult[] = [];
    const allEntries: Array<{
      providerName: string;
      modelId: string;
      preset: string;
    }> = [];

    for (const [providerName, provider] of Object.entries(output.providers)) {
      for (const model of provider.models) {
        // Extract preset name from ID if using :: convention
        const preset = model.id.includes("::")
          ? model.id.split("::").pop()!
          : "default";
        allEntries.push({
          providerName,
          modelId: model.id,
          preset,
        });
      }
    }

    if (opts.sequential) {
      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i]!;
        console.log(
          `[${i + 1}/${allEntries.length}] Testing ${entry.providerName}/${entry.modelId} ...`,
        );
        const result = await smokeTestEntry(
          entry.providerName,
          entry.modelId,
          entry.preset,
        );
        results.push(result);
      }
    } else {
      // Parallel — but cap concurrency to avoid overwhelming pi
      const batchSize = 5;
      for (let i = 0; i < allEntries.length; i += batchSize) {
        const batch = allEntries.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((entry) =>
            smokeTestEntry(entry.providerName, entry.modelId, entry.preset),
          ),
        );
        results.push(...batchResults);
        console.log(
          `  Tested ${Math.min(i + batchSize, allEntries.length)}/${allEntries.length} entries`,
        );
      }
    }

    printSmokeTestSummary(results);

    // Exit with non-zero if any failed
    const hasFailures = results.some(
      (r) => r.status === "fail" || r.status === "timeout",
    );
    if (hasFailures) {
      process.exit(1);
    }
  }

  // No DB disconnect needed — all data came from the API
}

// Only run when invoked directly
if (import.meta.main) {
  main();
}
