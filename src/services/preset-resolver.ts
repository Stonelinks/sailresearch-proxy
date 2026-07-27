/**
 * Resolve `model::preset` variant ids. generate-models-json emits these in
 * pi's models.json (one pi model entry per researched sampling preset), but
 * Sail only knows the base model id — so the proxy strips the suffix and
 * merges the preset's researched sampling params into the request body.
 * Keys the client set explicitly win over preset params.
 */
import { log } from "../../shared/logger.ts";

export async function resolvePresetModel(
  body: Record<string, any>,
): Promise<Record<string, any>> {
  const model = body.model;
  if (typeof model !== "string" || !model.includes("::")) return body;

  const sep = model.indexOf("::");
  const baseModel = model.slice(0, sep);
  const presetName = model.slice(sep + 2);
  const out: Record<string, any> = { ...body, model: baseModel };

  try {
    // Lazy import so tests can mock the db module.
    const { prisma } = await import("../db.ts");
    const meta = await prisma.modelMeta.findUnique({
      where: { modelId: baseModel },
      include: { samplingPresets: true },
    });
    const preset = meta?.samplingPresets.find((p) => p.name === presetName);
    if (!preset) {
      log.warn(
        `[preset-resolver] no preset "${presetName}" for ${baseModel}; forwarding base model without params`,
      );
      return out;
    }
    const params = JSON.parse(preset.params || "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(params)) {
      if (out[key] === undefined) out[key] = value;
    }
    log.debug(
      `[preset-resolver] ${model} -> ${baseModel} + params(${Object.keys(params).join(",")})`,
    );
  } catch (err) {
    log.warn(
      `[preset-resolver] failed to resolve preset for ${model}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return out;
}
