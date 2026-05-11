/**
 * Research AI model metadata using the pi SDK and upsert into the database.
 *
 * Library exports used by the server (e.g. GraphQL `refetchModel` mutation
 * via `research-models-runner.ts`):
 *   - `parseAndValidatePiOutput` — validate raw JSON from pi SDK
 *   - `runPiResearch` — run pi SDK prompt for a single model
 *   - `upsertModelMeta` — write research results to the database
 */
import { isValidCompletionWindow } from "./completion-window.ts";
import {
  type ModelPriceInput,
  type ModelResearchResult,
  type SamplingParamValue,
  type SamplingPresetInput,
} from "./types.ts";
import { runPiPrompt } from "./pi-session.ts";
import { extractJson } from "../shared/extract-json.ts";
import { log } from "../shared/logger.ts";
import { config } from "./config.ts";

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
 * Parse and validate raw JSON string from the pi SDK response into a typed
 * ModelResearchResult. Throws with a descriptive message on validation failure.
 */
export function parseAndValidatePiOutput(raw: string): ModelResearchResult {
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    throw new Error(`No JSON object found in pi output: ${raw.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    log.warn(
      `[research-models] extractJson returned invalid JSON (${(e as Error).message}): ${jsonStr.slice(0, 300)}`,
    );
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

// ─── Run research for a single model ────────────────────────────────────────

const PI_PROMPT_TEMPLATE = (modelId: string) =>
  `Research the AI model "${modelId}" and return ONLY a JSON object with these fields:
- contextSize: maximum context window size in tokens (integer or null if unknown)
- samplingPresets: array of recommended sampling parameter presets, each with {name, description, params}. params can include temperature, top_p, top_k, max_tokens, etc. Use an empty array if none found.
- description: a one-sentence description of the model
- source: the HuggingFace model card URL or other authoritative source
- reasoning: boolean — true if the model supports extended thinking / chain-of-thought reasoning, false otherwise
- thinkingLevelMap: if reasoning is true, an object mapping thinking levels to provider values. Keys: "off", "minimal", "low", "medium", "high", "xhigh". Values: a string to send to the provider, or null if the level is unsupported. If reasoning is false, omit this field or set to null.

Do NOT include pricing — that is scraped separately from the Sail docs.

Return ONLY the JSON object, no markdown fences, no commentary. Examples:

Non-reasoning model:
{"contextSize": 131072, "samplingPresets": [{"name": "default", "description": "General purpose", "params": {"temperature": 0.7, "top_p": 0.95}}], "description": "A large language model by ...", "source": "https://huggingface.co/org/model", "reasoning": false}

Reasoning model:
{"contextSize": 262144, "samplingPresets": [{"name": "default", "description": "General purpose", "params": {"temperature": 0.7, "top_p": 0.95}}], "description": "A reasoning model by ...", "source": "https://huggingface.co/org/model", "reasoning": true, "thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}}`;

export async function runPiResearch(
  modelId: string,
): Promise<ModelResearchResult> {
  const prompt = PI_PROMPT_TEMPLATE(modelId);

  const stdout = await runPiPrompt(prompt);

  log.debug(`[pi-research] raw output for ${modelId}: ${stdout.slice(0, 300)}`);

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    throw new Error(
      `No JSON object found in pi SDK response for ${modelId}. Raw output (first 200 chars): ${stdout.slice(0, 200)}`,
    );
  }

  return parseAndValidatePiOutput(jsonStr);
}

// ─── Smoke test presets ────────────────────────────────────────────────────

export interface SmokeTestResult {
  presetName: string;
  thinkingLevel: string | null;
  ok: boolean;
  error?: string;
}

/**
 * Smoke test a single preset + optional thinking level by sending a "hi"
 * prompt through the proxy's /v1/chat/completions endpoint.
 *
 * @param baseUrl  Full URL for the chat completions endpoint.
 *                Defaults to `http://127.0.0.1:{port}/v1/chat/completions`.
 */
export async function smokeTestPreset(
  modelId: string,
  params: Record<string, SamplingParamValue>,
  thinkingLevel: string | null = null,
  baseUrl: string = `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
): Promise<SmokeTestResult> {
  const url = baseUrl;

  const body: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    ...params,
  };

  if (thinkingLevel) {
    body.reasoning_effort = thinkingLevel;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errorDetail: string;
      try {
        const errBody = (await res.json()) as any;
        errorDetail =
          errBody?.error?.message ??
          JSON.stringify(errBody)?.slice(0, 200) ??
          res.statusText;
      } catch {
        errorDetail = `${res.status} ${res.statusText}`;
      }
      return {
        presetName: "",
        thinkingLevel,
        ok: false,
        error: errorDetail,
      };
    }

    const data = (await res.json()) as any;
    const content =
      data?.choices?.[0]?.message?.content ?? data?.output?.[0]?.text ?? "";
    const trimmed = typeof content === "string" ? content.trim() : "";

    if (trimmed.length === 0) {
      return {
        presetName: "",
        thinkingLevel,
        ok: false,
        error: "empty response content",
      };
    }

    return {
      presetName: "",
      thinkingLevel,
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      presetName: "",
      thinkingLevel,
      ok: false,
      error: msg,
    };
  }
}

/**
 * Find the highest non-null thinking level value from a thinkingLevelMap.
 * Returns null if no valid level found.
 */
function highestThinkingLevel(
  thinkingLevelMap: Record<string, string | null>,
): string | null {
  // Check levels from highest to lowest
  for (const level of ["xhigh", "high", "medium", "low", "minimal"] as const) {
    const value = thinkingLevelMap[level];
    if (value !== undefined && value !== null) {
      return level;
    }
  }
  return null;
}

/**
 * Smoke test all presets for a model. For each preset, tests base params
 * and (for reasoning models) one thinking level. Returns results for each
 * combination, with presetName filled in.
 *
 * Runs sequentially to avoid overwhelming Sail.
 *
 * @param baseUrl  Full URL for the chat completions endpoint.
 *                Defaults to `http://127.0.0.1:{port}/v1/chat/completions`.
 */
export async function smokeTestPresets(
  modelId: string,
  presets: SamplingPresetInput[],
  thinkingLevelMap: Record<string, string | null> | null,
  baseUrl: string = `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
): Promise<SmokeTestResult[]> {
  const results: SmokeTestResult[] = [];

  // Pick the highest available thinking level to test with
  const testThinkingLevel = thinkingLevelMap
    ? highestThinkingLevel(thinkingLevelMap)
    : null;

  for (const preset of presets) {
    // Test base params (no thinking level)
    const baseResult = await smokeTestPreset(modelId, preset.params, null, baseUrl);
    baseResult.presetName = preset.name;
    results.push(baseResult);

    // For reasoning models, also test with a thinking level
    if (testThinkingLevel) {
      const thinkResult = await smokeTestPreset(
        modelId,
        preset.params,
        testThinkingLevel,
        baseUrl,
      );
      thinkResult.presetName = preset.name;
      results.push(thinkResult);
    }
  }

  return results;
}

// ─── Upsert model metadata ─────────────────────────────────────────────────

export async function upsertModelMeta(
  modelId: string,
  result: ModelResearchResult,
): Promise<void> {
  const { prisma } = await import("./db.ts");
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
