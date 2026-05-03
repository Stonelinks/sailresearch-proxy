/**
 * Small display helpers shared across pages. shortModel/shortOwner used
 * to live as inline copies in three Svelte files; pulling them here so
 * label conventions stay consistent.
 */

/**
 * Drop everything before the last slash on a model id:
 * "org-a/Model-V1" → "Model-V1", "vendor/org/Model" → "Model".
 * Uses lastIndexOf so multi-segment vendor paths still surface only the
 * model name.
 */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Same shape as shortModel but for owned_by, which can be null/undefined. */
export function shortOwner(owned_by: string | null | undefined): string {
  if (!owned_by) return "—";
  const slash = owned_by.lastIndexOf("/");
  return slash >= 0 ? owned_by.slice(slash + 1) : owned_by;
}

/** Render a context-window size as 1.2M / 64K / raw integer, "—" for null. */
export function formatContextSize(size: number | null): string {
  if (size === null) return "—";
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`;
  if (size >= 1_000) return `${(size / 1_000).toFixed(0)}K`;
  return String(size);
}
