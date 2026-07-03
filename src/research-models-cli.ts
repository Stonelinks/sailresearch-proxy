/**
 * CLI for model research — the entrypoint behind `bin/research-models`.
 *
 * Researches models via the same runner the GraphQL `researchAllModels`
 * mutation uses (`researchAndUpsertMany`): scrapes the Sail docs once, runs
 * pi research + window compatibility + preset smoke tests per model, and
 * upserts results into the database.
 *
 * Requirements / caveats:
 *   - The proxy must be running (pi research and smoke tests route through
 *     it). The CLI health-checks `{base}/v1/models` before starting.
 *   - Needs env.sh (SAIL_API_KEY, DATABASE_URL) — the `bin/research-models`
 *     shim sources it.
 *   - `--base-url` only affects the model list + health check; smoke tests
 *     and pi research always target `http://127.0.0.1:{PORT}` (from config),
 *     so PORT must match the running proxy.
 *   - Research progress is tracked in this process only — the web UI's
 *     research indicators will not reflect a CLI run. Avoid running this
 *     concurrently with a UI-triggered "Research All".
 *   - Stale ModelMeta cleanup only runs when researching the full model
 *     list (no explicit model IDs given).
 */
import { researchAndUpsertMany } from "./graphql/research-models-runner.ts";
import { config } from "./config.ts";

export interface CliOptions {
  baseUrl: string;
  modelIds: string[];
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: `http://127.0.0.1:${config.server.port}/v1`,
    modelIds: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bin/research-models [modelId ...] [options]

Arguments:
  [modelId ...]       Research only these models
                      (default: all models from {base-url}/models)

Options:
  --base-url <url>    Proxy base URL for the model list + health check
                      (default: http://127.0.0.1:${config.server.port}/v1)
  -h, --help          Show this help

Researches model metadata (context size, sampling presets, description,
reasoning support) with the embedded pi SDK, tests completion-window
compatibility and presets against the running proxy, and upserts the
results into the database — the same flow as the dashboard's
"Research All" button.

The proxy must be running (bin/dev or bin/run). Note that smoke tests and
pi research always target port ${config.server.port} (PORT env), regardless
of --base-url. When run without explicit model IDs, metadata rows for
models no longer in Sail's API are deleted.`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg} (see --help)`);
      process.exit(1);
    } else {
      opts.modelIds.push(arg);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Health check — research is pointless without a reachable proxy
  const modelsUrl =
    opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "") + "/v1/models";
  console.log(`Checking proxy at ${modelsUrl} ...`);
  let modelList: string[];
  try {
    const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    modelList = (body.data ?? []).map((m) => m.id);
    console.log(`  ✓ Proxy is reachable (${modelList.length} models)\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Proxy is not reachable at ${modelsUrl} (${msg})`);
    console.error("Start the proxy first with: bin/dev  or  bin/run");
    process.exit(1);
  }

  const explicit = opts.modelIds.length > 0;
  const ids = explicit ? opts.modelIds : modelList;
  if (ids.length === 0) {
    console.error("ERROR: no models to research");
    process.exit(1);
  }

  console.log(
    `Researching ${ids.length} model(s), up to ${config.research.maxConcurrent} at a time ...\n`,
  );
  const startedAt = Date.now();
  const errors = await researchAndUpsertMany(ids, { pruneStale: !explicit });
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  console.log("");
  if (errors.length > 0) {
    console.error(`✗ ${errors.length}/${ids.length} model(s) failed:`);
    for (const e of errors) {
      console.error(`  ${e.modelId}: ${e.error}`);
    }
  }
  console.log(
    `Done: ${ids.length - errors.length}/${ids.length} succeeded in ${elapsed}s`,
  );

  // Explicit exit releases the Prisma/DB handle
  process.exit(errors.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
