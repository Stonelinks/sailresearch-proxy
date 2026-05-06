/**
 * Research AI model metadata using the `pi` CLI and upsert into the database.
 *
 * Usage: bun run src/research-models.ts [--sequential]
 *
 * Default: runs research in parallel for all models.
 * --sequential: researches models one at a time.
 */
import { prisma } from "./db.ts";
import { isValidCompletionWindow } from "./completion-window.ts";
import {
  type ModelPriceInput,
  type ModelResearchResult,
  type SamplingParamValue,
  type SamplingPresetInput,
} from "./types.ts";
import { scrapeImageCapabilities, scrapePricing } from "./docs-scraper.ts";

// ─── CLI arg parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sequential = args.includes("--sequential");

// ─── Validation ─────────────────────────────────────────────────────────────

function isSamplingParamValue(v: unknown): v is SamplingParamValue {
  return (
    typeof v === "number" || typeof v === "string" || typeof v === "boolean"
  );
}

function validateSamplingPreset(
  raw: unknown,
  index: number,
): SamplingPresetInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `samplingPresets[${index}]: expected object, got ${typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new Error(
      `samplingPresets[${index}]: "name" must be a non-empty string`,
    );
  }
  if (typeof obj.description !== "string") {
    throw new Error(
      `samplingPresets[${index}]: "description" must be a string`,
    );
  }
  if (
    typeof obj.params !== "object" ||
    obj.params === null ||
    Array.isArray(obj.params)
  ) {
    throw new Error(`samplingPresets[${index}]: "params" must be an object`);
  }

  const params: Record<string, SamplingParamValue> = {};
  for (const [key, val] of Object.entries(
    obj.params as Record<string, unknown>,
  )) {
    if (!isSamplingParamValue(val)) {
      throw new Error(
        `samplingPresets[${index}].params.${key}: expected number|string|boolean, got ${typeof val}`,
      );
    }
    params[key] = val;
  }

  return { name: obj.name, description: obj.description, params };
}

function validatePriceEntry(raw: unknown, index: number): ModelPriceInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`prices[${index}]: expected object, got ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.completionWindow !== "string" ||
    !isValidCompletionWindow(obj.completionWindow)
  ) {
    throw new Error(
      `prices[${index}]: "completionWindow" must be one of asap|priority|standard|flex, got ${JSON.stringify(obj.completionWindow)}`,
    );
  }
  if (typeof obj.inputPerMTok !== "number") {
    throw new Error(
      `prices[${index}]: "inputPerMTok" must be a number, got ${typeof obj.inputPerMTok}`,
    );
  }
  if (typeof obj.outputPerMTok !== "number") {
    throw new Error(
      `prices[${index}]: "outputPerMTok" must be a number, got ${typeof obj.outputPerMTok}`,
    );
  }
  if (
    obj.cachedInputPerMTok !== undefined &&
    obj.cachedInputPerMTok !== null &&
    typeof obj.cachedInputPerMTok !== "number"
  ) {
    throw new Error(
      `prices[${index}]: "cachedInputPerMTok" must be a number or null, got ${typeof obj.cachedInputPerMTok}`,
    );
  }

  return {
    completionWindow: obj.completionWindow,
    inputPerMTok: obj.inputPerMTok,
    cachedInputPerMTok:
      typeof obj.cachedInputPerMTok === "number"
        ? obj.cachedInputPerMTok
        : null,
    outputPerMTok: obj.outputPerMTok,
  };
}

const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

function validateThinkingLevelMap(
  raw: unknown,
): Record<string, string | null> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const map: Record<string, string | null> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_THINKING_LEVELS.includes(key as ThinkingLevel)) continue;
    if (val === null) {
      map[key] = null;
    } else if (typeof val === "string") {
      map[key] = val;
    }
    // skip non-string non-null values
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * Parse and validate raw JSON string from the pi subprocess into a typed
 * ModelResearchResult. Throws with a descriptive message on validation failure.
 */
export function parseAndValidatePiOutput(raw: string): ModelResearchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // contextSize
  if (
    obj.contextSize !== undefined &&
    obj.contextSize !== null &&
    typeof obj.contextSize !== "number"
  ) {
    throw new Error(
      `"contextSize" must be a number or null, got ${typeof obj.contextSize}`,
    );
  }
  const contextSize: number | null =
    typeof obj.contextSize === "number" ? obj.contextSize : null;

  // samplingPresets
  if (
    obj.samplingPresets !== undefined &&
    !Array.isArray(obj.samplingPresets)
  ) {
    throw new Error(
      `"samplingPresets" must be an array, got ${typeof obj.samplingPresets}`,
    );
  }
  const rawPresets: unknown[] = Array.isArray(obj.samplingPresets)
    ? obj.samplingPresets
    : [];
  const samplingPresets: SamplingPresetInput[] = rawPresets.map((p, i) =>
    validateSamplingPreset(p, i),
  );

  // prices
  if (obj.prices !== undefined && !Array.isArray(obj.prices)) {
    throw new Error(`"prices" must be an array, got ${typeof obj.prices}`);
  }
  const rawPrices: unknown[] = Array.isArray(obj.prices) ? obj.prices : [];
  const seenWindows = new Set<string>();
  const prices: ModelPriceInput[] = rawPrices.map((p, i) => {
    const entry = validatePriceEntry(p, i);
    if (seenWindows.has(entry.completionWindow)) {
      throw new Error(
        `prices[${i}]: duplicate completionWindow "${entry.completionWindow}"`,
      );
    }
    seenWindows.add(entry.completionWindow);
    return entry;
  });

  // description
  if (
    obj.description !== undefined &&
    obj.description !== null &&
    typeof obj.description !== "string"
  ) {
    throw new Error(
      `"description" must be a string or null, got ${typeof obj.description}`,
    );
  }
  const description: string | null =
    typeof obj.description === "string" ? obj.description : null;

  // source
  if (
    obj.source !== undefined &&
    obj.source !== null &&
    typeof obj.source !== "string"
  ) {
    throw new Error(
      `"source" must be a string or null, got ${typeof obj.source}`,
    );
  }
  const source: string | null =
    typeof obj.source === "string" ? obj.source : null;

  // reasoning
  if (
    obj.reasoning !== undefined &&
    obj.reasoning !== null &&
    typeof obj.reasoning !== "boolean"
  ) {
    throw new Error(
      `"reasoning" must be a boolean or null, got ${typeof obj.reasoning}`,
    );
  }
  const reasoning: boolean =
    typeof obj.reasoning === "boolean" ? obj.reasoning : false;

  // thinkingLevelMap
  const thinkingLevelMap = validateThinkingLevelMap(obj.thinkingLevelMap);

  return {
    contextSize,
    samplingPresets,
    prices,
    description,
    source,
    supportsImage:
      typeof obj.supportsImage === "boolean" ? obj.supportsImage : false,
    reasoning,
    thinkingLevelMap,
  };
}

// ─── Fetch model list from proxy ────────────────────────────────────────────

async function fetchModelList(proxyUrl: string): Promise<string[]> {
  const res = await fetch(`${proxyUrl}/v1/models`);
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

// ─── Run pi research for a single model ─────────────────────────────────────

const PI_PROMPT_TEMPLATE = (modelId: string) =>
  `Research the AI model "${modelId}" and return ONLY a JSON object with these fields:
- contextSize: maximum context window size in tokens (integer or null if unknown)
- samplingPresets: array of recommended sampling parameter presets, each with {name, description, params}. params can include temperature, top_p, top_k, max_tokens, etc. Use an empty array if none found.
- description: a one-sentence description of the model
- source: the HuggingFace model card URL or other authoritative source
- reasoning: boolean — true if the model supports extended thinking / chain-of-thought reasoning, false otherwise
- thinkingLevelMap: if reasoning is true, an object mapping pi thinking levels to provider values. Keys: "off", "minimal", "low", "medium", "high", "xhigh". Values: a string to send to the provider, or null if the level is unsupported. If reasoning is false, omit this field or set to null.

Do NOT include pricing — that is scraped separately from the Sail docs.

Return ONLY the JSON object, no markdown fences, no commentary. Examples:

Non-reasoning model:
{"contextSize": 131072, "samplingPresets": [{"name": "default", "description": "General purpose", "params": {"temperature": 0.7, "top_p": 0.95}}], "description": "A large language model by ...", "source": "https://huggingface.co/org/model", "reasoning": false}

Reasoning model:
{"contextSize": 262144, "samplingPresets": [{"name": "default", "description": "General purpose", "params": {"temperature": 0.7, "top_p": 0.95}}], "description": "A reasoning model by ...", "source": "https://huggingface.co/org/model", "reasoning": true, "thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}}`;

/**
 * Extract a JSON object from raw pi output.
 * Handles both raw JSON and markdown-fenced JSON.
 */
function extractJson(raw: string): string | null {
  // Try raw JSON object (first { ... } block at line start)
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

  // Try extracting from markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  return null;
}

export async function runPiResearch(
  modelId: string,
): Promise<ModelResearchResult> {
  const prompt = PI_PROMPT_TEMPLATE(modelId);

  const proc = Bun.spawn(["pi", "-p", "--no-session", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `pi exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    throw new Error("No JSON object found in pi output");
  }

  return parseAndValidatePiOutput(jsonStr);
}

// ─── Upsert model metadata ─────────────────────────────────────────────────

export async function upsertModelMeta(
  modelId: string,
  result: ModelResearchResult,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Upsert ModelMeta
    const meta = await tx.modelMeta.upsert({
      where: { modelId },
      update: {
        contextSize: result.contextSize,
        description: result.description,
        source: result.source,
        supportsImage: result.supportsImage,
        reasoning: result.reasoning,
        thinkingLevelMap: result.thinkingLevelMap
          ? JSON.stringify(result.thinkingLevelMap)
          : null,
        researchedAt: new Date(),
      },
      create: {
        modelId,
        contextSize: result.contextSize,
        description: result.description,
        source: result.source,
        supportsImage: result.supportsImage,
        reasoning: result.reasoning,
        thinkingLevelMap: result.thinkingLevelMap
          ? JSON.stringify(result.thinkingLevelMap)
          : null,
      },
    });

    // Delete old presets and re-create
    await tx.samplingPreset.deleteMany({ where: { modelMetaId: meta.id } });

    for (const preset of result.samplingPresets) {
      await tx.samplingPreset.create({
        data: {
          modelMetaId: meta.id,
          name: preset.name,
          description: preset.description,
          params: JSON.stringify(preset.params),
        },
      });
    }

    // Delete old prices and re-create
    await tx.modelPrice.deleteMany({ where: { modelMetaId: meta.id } });

    for (const price of result.prices) {
      await tx.modelPrice.create({
        data: {
          modelMetaId: meta.id,
          completionWindow: price.completionWindow,
          inputPerMTok: price.inputPerMTok,
          cachedInputPerMTok: price.cachedInputPerMTok,
          outputPerMTok: price.outputPerMTok,
        },
      });
    }
  });
}

// ─── Orchestration ──────────────────────────────────────────────────────────

interface ResearchOutcome {
  modelId: string;
  status: "success" | "failed";
  error?: string;
  contextSize?: number | null;
  presetCount?: number;
}

async function researchSingleModel(
  modelId: string,
  index: number,
  total: number,
  scrapedPrices: Map<string, ModelPriceInput[]>,
  imageCapabilities: Map<string, boolean>,
): Promise<ResearchOutcome> {
  const prefix = sequential ? `[${index}/${total}]` : `[${index}/${total}]`;
  console.log(`${prefix} Researching: ${modelId}`);

  try {
    const result = await runPiResearch(modelId);

    // Merge scraped pricing (authoritative source) over pi-researched prices
    const scraped = scrapedPrices.get(modelId);
    if (scraped && scraped.length > 0) {
      result.prices = scraped;
    }

    // Merge scraped image capability
    const imageCap = imageCapabilities.get(modelId);
    if (imageCap !== undefined) {
      result.supportsImage = imageCap;
    }

    console.log(
      `  ✓ ${modelId} — contextSize=${result.contextSize}, presets=${result.samplingPresets.length}, prices=${result.prices.length}, supportsImage=${result.supportsImage}, reasoning=${result.reasoning}, source=${result.source ?? "n/a"}`,
    );
    await upsertModelMeta(modelId, result);
    console.log(`  ✓ Upserted ${modelId}`);
    return {
      modelId,
      status: "success",
      contextSize: result.contextSize,
      presetCount: result.samplingPresets.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${modelId}: ${msg}`);
    return { modelId, status: "failed", error: msg };
  }
}

async function researchAllModels(
  modelIds: string[],
  scrapedPrices: Map<string, ModelPriceInput[]>,
  imageCapabilities: Map<string, boolean>,
): Promise<ResearchOutcome[]> {
  const total = modelIds.length;

  if (sequential) {
    console.log(`Running in sequential mode (${total} models)\n`);
    const outcomes: ResearchOutcome[] = [];
    for (let i = 0; i < modelIds.length; i++) {
      const outcome = await researchSingleModel(
        modelIds[i]!,
        i + 1,
        total,
        scrapedPrices,
        imageCapabilities,
      );
      outcomes.push(outcome);
    }
    return outcomes;
  }

  console.log(`Running in parallel mode (${total} models)\n`);

  // Fire all at once, but collect results with index for logging
  const outcomes = await Promise.all(
    modelIds.map((modelId, i) =>
      researchSingleModel(
        modelId,
        i + 1,
        total,
        scrapedPrices,
        imageCapabilities,
      ),
    ),
  );
  return outcomes;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const proxyUrl = process.env.PROXY_URL ?? "http://localhost:4000";

  // Health check
  console.log(`Checking proxy at ${proxyUrl}/v1/models ...`);
  try {
    const res = await fetch(`${proxyUrl}/v1/models`);
    if (!res.ok) throw new Error(`${res.status}`);
    console.log("  ✓ Proxy is reachable\n");
  } catch {
    console.error(`ERROR: Proxy is not reachable at ${proxyUrl}/v1/models`);
    console.error("Start the proxy first with: bin/dev  or  bin/run");
    process.exit(1);
  }

  // Fetch model list
  console.log("Fetching model list ...");
  let modelIds: string[];
  try {
    modelIds = await fetchModelList(proxyUrl);
    console.log(`  ✓ Found ${modelIds.length} models\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }

  // Scrape docs pages for pricing and image capabilities
  console.log("Scraping Sail docs for pricing ...");
  let scrapedPrices: Map<string, ModelPriceInput[]>;
  try {
    scrapedPrices = await scrapePricing();
    console.log(
      `  ✓ Pricing scraped for ${scrapedPrices.size} models from docs\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Pricing scrape failed: ${msg}`);
    console.warn(
      "  Continuing without scraped pricing — pi research may provide it.\n",
    );
    scrapedPrices = new Map();
  }

  console.log("Scraping Sail docs for image capabilities ...");
  let imageCapabilities: Map<string, boolean>;
  try {
    imageCapabilities = await scrapeImageCapabilities();
    console.log(
      `  ✓ Image capabilities scraped: ${[...imageCapabilities.entries()].filter(([, v]) => v).length} models support images\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Image capability scrape failed: ${msg}\n`);
    imageCapabilities = new Map();
  }

  // Research
  const outcomes = await researchAllModels(
    modelIds,
    scrapedPrices,
    imageCapabilities,
  );

  // Summary
  const succeeded = outcomes.filter((o) => o.status === "success");
  const failed = outcomes.filter((o) => o.status === "failed");

  console.log("");
  console.log("========================================");
  console.log(
    `Research complete: ${succeeded.length} succeeded, ${failed.length} failed out of ${outcomes.length} models`,
  );
  if (failed.length > 0) {
    console.log("Failed models:");
    for (const f of failed) {
      console.log(`  - ${f.modelId}: ${f.error ?? "unknown error"}`);
    }
  }
  console.log("========================================");

  await prisma.$disconnect();
}

// Only run main() when invoked as a script (bun run src/research-models.ts).
// When this file is imported as a module (e.g. by the GraphQL refetchModel
// resolver), the exported helpers are used directly.
if (import.meta.main) {
  main();
}
