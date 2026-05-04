/**
 * Research AI model metadata using the `pi` CLI and upsert into the database.
 *
 * Usage: bun run src/research-models.ts [--sequential]
 *
 * Default: runs research in parallel for all models.
 * --sequential: researches models one at a time.
 */
import { prisma } from "./db.ts";
import {
  type ModelResearchResult,
  type SamplingParamValue,
  type SamplingPresetInput,
} from "./types.ts";

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

  return { contextSize, samplingPresets, description, source };
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
- source: the URL where you found this information (e.g. HuggingFace model card)

Use web search or browser tools to find this information from official sources like HuggingFace model cards, documentation, or technical reports.

Return ONLY the JSON object, no markdown fences, no commentary. Example:
{"contextSize": 131072, "samplingPresets": [{"name": "default", "description": "General purpose", "params": {"temperature": 0.7, "top_p": 0.95}}], "description": "A large language model by ...", "source": "https://huggingface.co/..."}`;

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
        researchedAt: new Date(),
      },
      create: {
        modelId,
        contextSize: result.contextSize,
        description: result.description,
        source: result.source,
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
): Promise<ResearchOutcome> {
  const prefix = sequential ? `[${index}/${total}]` : `[${index}/${total}]`;
  console.log(`${prefix} Researching: ${modelId}`);

  try {
    const result = await runPiResearch(modelId);
    console.log(
      `  ✓ ${modelId} — contextSize=${result.contextSize}, presets=${result.samplingPresets.length}, source=${result.source ?? "n/a"}`,
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
): Promise<ResearchOutcome[]> {
  const total = modelIds.length;

  if (sequential) {
    console.log(`Running in sequential mode (${total} models)\n`);
    const outcomes: ResearchOutcome[] = [];
    for (let i = 0; i < modelIds.length; i++) {
      const outcome = await researchSingleModel(modelIds[i]!, i + 1, total);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  console.log(`Running in parallel mode (${total} models)\n`);

  // Fire all at once, but collect results with index for logging
  const outcomes = await Promise.all(
    modelIds.map((modelId, i) => researchSingleModel(modelId, i + 1, total)),
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

  // Research
  const outcomes = await researchAllModels(modelIds);

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
