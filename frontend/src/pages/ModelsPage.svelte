<script lang="ts">
  import { onMount } from "svelte";
  import { graphql } from "$houdini";
  import {
    shortOwner,
    formatContextSize,
    formatPriceFrom,
    formatUsdPerMTok,
  } from "../format";
  import { log } from "$shared/logger.ts";

  // Canonical display order matches the docs page columns.
  const WINDOW_ORDER = ["standard", "priority", "flex", "asap"] as const;
  const WINDOW_LABELS: Record<(typeof WINDOW_ORDER)[number], string> = {
    standard: "Standard",
    priority: "Priority",
    flex: "Flex",
    asap: "ASAP",
  };

  let search = $state("");
  let expandedPresets: Set<string> = $state(new Set());
  let refetchingId = $state<string | null>(null);

  const Models = graphql(`
    query ModelsList {
      models {
        id
        object
        created
        ownedBy
        contextSize
        description
        source
        researchedAt
        samplingPresets {
          name
          description
          params
        }
        prices {
          completionWindow
          inputPerMTok
          cachedInputPerMTok
          outputPerMTok
          currency
        }
      }
    }
  `);

  const RefetchModel = graphql(`
    mutation RefetchModel($modelId: ID!) {
      refetchModel(modelId: $modelId) {
        id
        contextSize
        description
        source
        researchedAt
        samplingPresets {
          name
          description
          params
        }
        prices {
          completionWindow
          inputPerMTok
          cachedInputPerMTok
          outputPerMTok
          currency
        }
      }
    }
  `);

  let models = $derived($Models.data?.models ?? []);
  let loading = $derived($Models.fetching);
  let error = $derived($Models.errors?.[0]?.message ?? "");

  let filtered = $derived(
    search
      ? models.filter((m) =>
          m.id.toLowerCase().includes(search.toLowerCase()),
        )
      : models,
  );

  type PriceRow = {
    completionWindow: string;
    inputPerMTok: number;
    cachedInputPerMTok: number | null;
    outputPerMTok: number;
    currency: string;
  };

  function orderedPrices(
    prices: ReadonlyArray<PriceRow> | null | undefined,
  ): PriceRow[] {
    if (!prices) return [];
    const byWindow = new Map(prices.map((p) => [p.completionWindow, p]));
    return WINDOW_ORDER.map((w) => byWindow.get(w)).filter(
      (p): p is PriceRow => !!p,
    );
  }

  function windowLabel(window: string): string {
    return (WINDOW_LABELS as Record<string, string>)[window] ?? window;
  }

  function togglePresets(modelId: string) {
    const next = new Set(expandedPresets);
    if (next.has(modelId)) {
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    expandedPresets = next;
  }

  async function refetchOne(modelId: string) {
    refetchingId = modelId;
    try {
      log.debug("Refetching model", modelId);
      const result = await RefetchModel.mutate({ modelId });
      if (result.errors?.length) {
        log.error("Refetch failed:", result.errors[0].message);
        // Surface the error to the user; the list query stays as-is.
        // eslint-disable-next-line no-alert
        alert(`Refetch failed: ${result.errors[0].message}`);
      } else {
        // Houdini's normalized cache merges the mutation result into the
        // list query automatically — no manual list refetch needed.
        log.debug("Refetched", modelId);
      }
    } finally {
      refetchingId = null;
    }
  }

  onMount(() => {
    Models.fetch();
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <h2 class="text-lg font-semibold">Available Models</h2>
    <div class="flex items-center gap-2">
      <label for="model-search" class="text-sm text-slate-500">Search:</label>
      <input
        id="model-search"
        type="text"
        bind:value={search}
        placeholder="Filter models…"
        class="text-sm px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-300"
      />
    </div>
  </div>

  {#if loading && models.length === 0}
    <div class="text-center py-16 text-slate-400">Loading…</div>
  {:else if error}
    <div class="text-center py-16 text-slate-400">
      <p class="text-lg mb-2">Failed to load models</p>
      <p class="text-sm">{error}</p>
    </div>
  {:else}
    <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200">
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Model ID</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Owner</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Context</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Price</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Description</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Presets</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Created</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap"></th>
            </tr>
          </thead>
          <tbody>
            {#if filtered.length === 0}
              <tr>
                <td colspan="8" class="text-center py-10 text-slate-400">No models found.</td>
              </tr>
            {:else}
              {#each filtered as model (model.id)}
                <tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td class="px-4 py-2.5 font-mono text-xs">
                    {model.id}
                    {#if model.contextSize === null}
                      <span class="ml-1.5 inline-block text-[10px] font-sans font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">Not researched</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-sm text-slate-600">{shortOwner(model.ownedBy)}</td>
                  <td class="px-4 py-2.5 text-sm text-slate-500 whitespace-nowrap">
                    {#if model.contextSize !== null}
                      <span class="font-mono text-xs">{formatContextSize(model.contextSize)}</span>
                    {:else}
                      <span class="text-slate-300">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-sm text-slate-500 whitespace-nowrap">
                    {#if model.prices && model.prices.length > 0}
                      <span class="font-mono text-xs">{formatPriceFrom(model.prices)}</span>
                    {:else}
                      <span class="text-slate-300">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-sm text-slate-500 max-w-xs truncate">
                    {#if model.description}
                      <span title={model.description}>{model.description}</span>
                    {:else}
                      <span class="text-slate-300">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5">
                    {#if (model.samplingPresets && model.samplingPresets.length > 0) || (model.prices && model.prices.length > 0)}
                      <button
                        onclick={() => togglePresets(model.id)}
                        class="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                      >
                        {#if model.samplingPresets && model.samplingPresets.length > 0}
                          {model.samplingPresets.length} preset{model.samplingPresets.length !== 1 ? 's' : ''}
                        {:else}
                          Pricing
                        {/if}
                        {expandedPresets.has(model.id) ? ' ▾' : ' ▸'}
                      </button>
                    {:else}
                      <span class="text-slate-300 text-xs">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-sm text-slate-500">
                    {new Date(model.created * 1000).toLocaleDateString()}
                  </td>
                  <td class="px-4 py-2.5 text-right">
                    <button
                      onclick={() => refetchOne(model.id)}
                      disabled={refetchingId === model.id}
                      class="text-xs px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {refetchingId === model.id ? "Refetching…" : "Refetch"}
                    </button>
                  </td>
                </tr>
                {#if expandedPresets.has(model.id) && ((model.samplingPresets && model.samplingPresets.length > 0) || (model.prices && model.prices.length > 0))}
                  <tr class="bg-slate-50/50">
                    <td colspan="8" class="px-4 py-3">
                      {#if model.prices && model.prices.length > 0}
                        <div class="ml-4 mb-3">
                          <div class="text-xs font-semibold text-slate-600 mb-1">Pricing (USD per 1M tokens)</div>
                          <table class="text-xs font-mono">
                            <thead>
                              <tr class="text-slate-500">
                                <th class="text-left pr-4 font-medium">Window</th>
                                <th class="text-right pr-4 font-medium">Input</th>
                                <th class="text-right pr-4 font-medium">Cached</th>
                                <th class="text-right font-medium">Output</th>
                              </tr>
                            </thead>
                            <tbody class="text-slate-700">
                              {#each orderedPrices(model.prices) as price}
                                <tr>
                                  <td class="pr-4 py-0.5">{windowLabel(price.completionWindow)}</td>
                                  <td class="pr-4 py-0.5 text-right">{formatUsdPerMTok(price.inputPerMTok)}</td>
                                  <td class="pr-4 py-0.5 text-right">
                                    {#if price.cachedInputPerMTok !== null}
                                      {formatUsdPerMTok(price.cachedInputPerMTok)}
                                    {:else}
                                      <span class="text-slate-300">—</span>
                                    {/if}
                                  </td>
                                  <td class="py-0.5 text-right">{formatUsdPerMTok(price.outputPerMTok)}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {/if}
                      <div class="flex flex-wrap gap-2 ml-4">
                        {#each model.samplingPresets ?? [] as preset}
                          <div class="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs shadow-sm max-w-xs">
                            <div class="font-semibold text-slate-700 mb-1">{preset.name}</div>
                            {#if preset.description}
                              <div class="text-slate-500 mb-1">{preset.description}</div>
                            {/if}
                            <div class="font-mono text-slate-600 space-x-2">
                              {#each Object.entries(preset.params) as [key, value]}
                                <span>{key}={value}</span>
                              {/each}
                            </div>
                          </div>
                        {/each}
                        {#if model.source}
                          <div class="text-xs text-slate-400 self-end ml-2">
                            <a href={model.source} target="_blank" rel="noopener" class="underline hover:text-slate-600">Source ↗</a>
                          </div>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <p class="text-xs text-slate-400 text-center">{filtered.length} model{filtered.length !== 1 ? 's' : ''}</p>
  {/if}
</div>
