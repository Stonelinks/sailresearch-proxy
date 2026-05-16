import { sail } from "../sail-client.ts";
import { mapSailError } from "../errors.ts";
import { config } from "../config.ts";
import { isValidCompletionWindow } from "../completion-window.ts";
import type { CompletionWindow } from "../types.ts";
import {
  mergeModelMeta,
  toRestShape,
  type ModelWire,
  type SailUpstreamModel,
} from "../models-meta.ts";

/**
 * Filter a list of enriched models to only those compatible with the
 * given completion window. Models with no `supportedWindows` data
 * (not yet researched) are included by default to avoid hiding
 * untested models.
 */
function filterByWindow(
  models: ModelWire[],
  window: CompletionWindow,
): ModelWire[] {
  return models.filter(
    (m) => m.supportedWindows === null || m.supportedWindows.includes(window),
  );
}

export async function handleModels(req: Request): Promise<Response> {
  // The dispatch layer injects x-completion-window when a window prefix
  // is present in the URL (e.g. /flex/v1/models).
  const headerWindow = req.headers.get("x-completion-window");
  const effectiveWindow: CompletionWindow =
    headerWindow && isValidCompletionWindow(headerWindow)
      ? headerWindow
      : config.defaults.completionWindow;

  const { status, data } = await sail.listModels();
  if (status !== 200) return mapSailError(status, data);
  const list = (data?.data ?? []) as SailUpstreamModel[];
  const { prisma } = await import("../db.ts");
  const metas = await prisma.modelMeta.findMany({
    include: { samplingPresets: true, prices: true },
  });
  const byId = new Map(metas.map((m) => [m.modelId, m]));

  // Build enriched model wires (includes supportedWindows)
  let wires = list.map((m) => mergeModelMeta(m, byId.get(m.id) ?? undefined));

  // When a window prefix is present, filter to only compatible models.
  // The header is set by the dispatch layer for prefixed routes
  // (e.g. /asap/v1/models, /flex/v1/models).
  // Unprefixed /v1/models returns all models with the x_supported_windows field.
  if (headerWindow && isValidCompletionWindow(headerWindow)) {
    wires = filterByWindow(wires, headerWindow);
  }

  const enriched = wires.map((m) => toRestShape(m, effectiveWindow));
  return Response.json({ object: data?.object ?? "list", data: enriched });
}
