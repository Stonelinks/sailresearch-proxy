/**
 * Upsert model metadata into the ModelMeta table.
 * Called by bin/research-models with: bun run src/research-models-upsert.ts <modelId> <jsonOutput>
 */
import { prisma } from "./db.ts";

const modelId = process.argv[2];
const jsonOutput = process.argv[3];

if (!modelId || !jsonOutput) {
  console.error(
    "Usage: bun run src/research-models-upsert.ts <modelId> <jsonOutput>",
  );
  process.exit(1);
}

let parsed: {
  contextSize?: number | null;
  samplingPresets?: Array<{
    name: string;
    description: string;
    params: Record<string, number | string | boolean>;
  }>;
  description?: string | null;
  source?: string | null;
};

try {
  parsed = JSON.parse(jsonOutput);
} catch (e) {
  console.error(`Failed to parse JSON for model ${modelId}:`, e);
  process.exit(1);
}

const contextSize = parsed.contextSize ?? null;
const samplingPresets = JSON.stringify(parsed.samplingPresets ?? []);
const description = parsed.description ?? null;
const source = parsed.source ?? null;

await prisma.modelMeta.upsert({
  where: { modelId },
  update: {
    contextSize,
    samplingPresets,
    description,
    source,
    researchedAt: new Date(),
  },
  create: {
    modelId,
    contextSize,
    samplingPresets,
    description,
    source,
  },
});

console.log(`  Upserted metadata for ${modelId} (contextSize=${contextSize})`);

await prisma.$disconnect();
