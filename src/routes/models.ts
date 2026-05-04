import { sail } from "../sail-client.ts";
import { mapSailError } from "../errors.ts";
import { config } from "../config.ts";
import { isValidCompletionWindow } from "../completion-window.ts";
import {
  mergeModelMeta,
  toRestShape,
  type SailUpstreamModel,
} from "../models-meta.ts";

export async function handleModels(req: Request): Promise<Response> {
  const headerWindow = req.headers.get("x-completion-window");
  const effectiveWindow =
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
  const enriched = list.map((m) =>
    toRestShape(
      mergeModelMeta(m, byId.get(m.id) ?? undefined),
      effectiveWindow,
    ),
  );
  return Response.json({ object: data?.object ?? "list", data: enriched });
}
