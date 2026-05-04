/**
 * Shared merge layer between the upstream Sail `/models` response (canonical
 * OpenAI shape) and the researcher-populated `ModelMeta` rows in SQLite.
 *
 * Two consumers:
 *  - The GraphQL `models` query and `refetchModel` mutation, which surface the
 *    enriched data in camelCase via the `Model` type.
 *  - The REST `/v1/models` route, which projects to OpenRouter's snake_case
 *    convention so OpenAI-compatible clients (LiteLLM, Aider, Continue, ...)
 *    can read context length, default sampling params, etc.
 */
import type { CompletionWindow } from "./types.ts";

/** Wire shape for a sampling preset returned by GraphQL. params is parsed. */
export interface PresetWire {
  name: string;
  description: string;
  params: Record<string, number | string | boolean>;
}

/** Wire shape for a per-completion-window price entry. */
export interface PriceWire {
  completionWindow: CompletionWindow;
  inputPerMTok: number;
  cachedInputPerMTok: number | null;
  outputPerMTok: number;
  currency: string;
}

/** Wire shape for a model returned by GraphQL. Sail fields + researched meta. */
export interface ModelWire {
  id: string;
  object: string;
  created: number;
  ownedBy: string;
  contextSize: number | null;
  samplingPresets: PresetWire[] | null;
  prices: PriceWire[] | null;
  description: string | null;
  source: string | null;
  researchedAt: string | null;
}

/** Shape of an entry from Sail's `/v1/models` response. */
export interface SailUpstreamModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/** ModelMeta row with samplingPresets and prices included. */
export interface MetaRow {
  modelId: string;
  contextSize: number | null;
  description: string | null;
  source: string | null;
  researchedAt: Date;
  samplingPresets: Array<{ name: string; description: string; params: string }>;
  prices: Array<{
    completionWindow: string;
    inputPerMTok: number;
    cachedInputPerMTok: number | null;
    outputPerMTok: number;
    currency: string;
  }>;
}

// A malformed params JSON string would crash the entire models query. Treat
// any parse failure as "no params" and keep going.
function parseSamplingParams(p: {
  name: string;
  description: string;
  params: string;
}): PresetWire {
  try {
    const parsed = JSON.parse(p.params);
    return {
      name: p.name,
      description: p.description,
      params:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, number | string | boolean>)
          : {},
    };
  } catch {
    return { name: p.name, description: p.description, params: {} };
  }
}

// Drop rows whose completionWindow string isn't one of the four canonical
// values. Defensive — the DB has no enum constraint, so a bad row would
// otherwise leak through to GraphQL/REST consumers as a typed CompletionWindow.
function isCanonicalWindow(w: string): w is CompletionWindow {
  return w === "asap" || w === "priority" || w === "standard" || w === "flex";
}

function rowToPriceWire(p: MetaRow["prices"][number]): PriceWire | null {
  if (!isCanonicalWindow(p.completionWindow)) return null;
  return {
    completionWindow: p.completionWindow,
    inputPerMTok: p.inputPerMTok,
    cachedInputPerMTok: p.cachedInputPerMTok,
    outputPerMTok: p.outputPerMTok,
    currency: p.currency,
  };
}

/** Combine an upstream Sail model with its (optional) researched meta row. */
export function mergeModelMeta(
  sail: SailUpstreamModel,
  meta: MetaRow | undefined,
): ModelWire {
  return {
    id: sail.id,
    object: sail.object,
    created: sail.created,
    ownedBy: sail.owned_by,
    contextSize: meta?.contextSize ?? null,
    samplingPresets: meta
      ? meta.samplingPresets.map(parseSamplingParams)
      : null,
    prices: meta
      ? (meta.prices ?? [])
          .map(rowToPriceWire)
          .filter((p): p is PriceWire => p !== null)
      : null,
    description: meta?.description ?? null,
    source: meta?.source ?? null,
    researchedAt: meta?.researchedAt?.toISOString() ?? null,
  };
}

function priceToRest(p: PriceWire): Record<string, unknown> {
  const out: Record<string, unknown> = {
    completion_window: p.completionWindow,
    input_per_mtok: p.inputPerMTok,
    output_per_mtok: p.outputPerMTok,
    currency: p.currency,
  };
  if (p.cachedInputPerMTok != null) {
    out.cached_input_per_mtok = p.cachedInputPerMTok;
  }
  return out;
}

function priceToOpenRouter(p: PriceWire): Record<string, string> {
  // OpenRouter quotes pricing as USD per token (not per MTok), as a string.
  const out: Record<string, string> = {
    prompt: (p.inputPerMTok / 1_000_000).toString(),
    completion: (p.outputPerMTok / 1_000_000).toString(),
  };
  if (p.cachedInputPerMTok != null) {
    out.input_cache_read = (p.cachedInputPerMTok / 1_000_000).toString();
  }
  return out;
}

/**
 * Project a ModelWire to the REST `/v1/models` shape. Follows the OpenRouter
 * convention (https://openrouter.ai/api/v1/models) — the de facto extension
 * point used by LiteLLM, Aider, and most OpenAI-compatible routers — since
 * canonical OpenAI emits no capability metadata. Fields the researcher hasn't
 * populated are omitted entirely (not emitted as `null`) so un-researched
 * models keep the canonical OpenAI shape rather than gaining empty slots.
 *
 * `effectiveWindow` selects which row of the per-window pricing table is
 * mirrored into the OpenRouter `pricing` object. When the model lacks that
 * window, we fall back to `flex` (the docs say unsupported windows route to
 * flex for billing) and annotate `x_billing_window` to make the substitution
 * explicit. The full per-window list is always emitted as
 * `x_pricing_by_completion_window`.
 */
export function toRestShape(
  m: ModelWire,
  effectiveWindow: CompletionWindow,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    object: m.object,
    created: m.created,
    owned_by: m.ownedBy,
  };
  if (m.contextSize != null) {
    out.context_length = m.contextSize;
    out.top_provider = { context_length: m.contextSize };
  }
  if (m.description != null) out.description = m.description;
  const presets = m.samplingPresets ?? [];
  if (presets.length > 0) {
    // Pick the preset named "default" if one exists; otherwise fall back to
    // load order. OpenRouter surfaces a single default_parameters object — our
    // richer named-preset list is exposed alongside as x_sampling_presets.
    const def = presets.find((p) => p.name === "default") ?? presets[0]!;
    out.default_parameters = def.params;
    const supported = new Set<string>();
    for (const p of presets)
      for (const k of Object.keys(p.params)) supported.add(k);
    out.supported_parameters = [...supported].sort();
    out.x_sampling_presets = presets;
  }
  const prices = m.prices ?? [];
  if (prices.length > 0) {
    const exact = prices.find((p) => p.completionWindow === effectiveWindow);
    if (exact) {
      out.pricing = priceToOpenRouter(exact);
    } else {
      const flex = prices.find((p) => p.completionWindow === "flex");
      if (flex) {
        out.pricing = priceToOpenRouter(flex);
        out.x_billing_window = "flex";
      }
    }
    out.x_pricing_by_completion_window = prices.map(priceToRest);
  }
  if (m.source != null) out.x_source = m.source;
  if (m.researchedAt != null) out.x_researched_at = m.researchedAt;
  return out;
}
