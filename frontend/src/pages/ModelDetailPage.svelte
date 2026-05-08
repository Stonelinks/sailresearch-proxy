<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { graphql } from "$houdini";
  import {
    shortOwner,
    formatContextSize,
    formatUsdPerMTok,
    formatPriceFrom,
  } from "../format";
  import { log } from "$shared/logger.ts";
  import { onWsConnected } from "../lib/houdini-client";

  import JsonBlock from "../components/JsonBlock.svelte";

  const WINDOW_ORDER = ["standard", "priority", "flex", "asap"] as const;
  const WINDOW_LABELS: Record<(typeof WINDOW_ORDER)[number], string> = {
    standard: "Standard",
    priority: "Priority",
    flex: "Flex",
    asap: "ASAP",
  };

  let { params }: { params: { id: string } } = $props();

  // ── Research state (server-synced) ──────────────────────────────────────
  let researchingIds = $state<Set<string>>(new Set());

  const ActiveResearch = graphql(`
    query ActiveResearchDetail {
      activeResearch {
        modelIds
        batch {
          id
          total
          completed
          errors
        }
      }
    }
  `);

  const ModelResearchUpdated = graphql(`
    subscription ModelResearchUpdatesDetail {
      modelResearchUpdated {
        modelId
        status
        error
        batch {
          id
          total
          completed
          errors
        }
      }
    }
  `);

  // ── Model query & mutation ──────────────────────────────────────────────

  const ModelQ = graphql(`
    query ModelDetail($id: ID!) {
      model(id: $id) {
        id
        object
        created
        ownedBy
        contextSize
        description
        source
        supportsImage
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
    mutation RefetchModelDetail($modelId: ID!) {
      refetchModel(modelId: $modelId) {
        id
        contextSize
        description
        source
        supportsImage
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

  let model = $derived($ModelQ.data?.model ?? null);
  let loading = $derived($ModelQ.fetching);
  let error = $derived($ModelQ.errors?.[0]?.message ?? "");

  let isResearching = $derived(researchingIds.has(params.id));

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

  function formatJsonParams(params: Record<string, unknown>): string {
    return JSON.stringify(params, null, 2);
  }

  async function load() {
    log.debug("Loading model", params.id);
    await ModelQ.fetch({ variables: { id: params.id } });
  }

  async function loadResearchState() {
    await ActiveResearch.fetch();
    const data = $ActiveResearchDetail.data?.activeResearch;
    if (data) {
      researchingIds = new Set(data.modelIds);
    }
  }

  async function refetch() {
    try {
      log.debug("Refetching model", params.id);
      const result = await RefetchModel.mutate({ modelId: params.id });
      if (result.errors?.length) {
        log.error("Refetch failed:", result.errors[0].message);
        alert(`Refetch failed: ${result.errors[0].message}`);
      } else {
        log.debug("Refetched", params.id);
      }
    } catch (err) {
      log.error("Refetch failed:", err);
    }
  }

  // Apply subscription updates
  $effect(() => {
    const update = $ModelResearchUpdated.data?.modelResearchUpdated;
    if (!update) return;

    const ids = untrack(() => researchingIds);
    const newIds = new Set(ids);

    if (update.status === "started") {
      newIds.add(update.modelId);
    } else {
      // "completed" or "failed"
      newIds.delete(update.modelId);
      // If this model completed, refetch its data
      if (update.modelId === untrack(() => params.id)) {
        load();
      }
    }

    researchingIds = newIds;
  });

  onMount(() => {
    load();
    loadResearchState();
    ModelResearchUpdated.listen();

    let firstConnect = true;
    const offWs = onWsConnected(() => {
      if (firstConnect) {
        firstConnect = false;
        return;
      }
      log.debug("WS reconnected, resyncing research state");
      loadResearchState();
      load();
    });

    return () => {
      offWs();
      ModelResearchUpdated.unlisten();
    };
  });

  // Re-fetch when navigating to a different model
  $effect(() => {
    params.id;
    load();
  });

  // Cached discount calculation
  let cachedDiscount = $derived(
    model?.prices?.filter((p) => p.cachedInputPerMTok !== null).map((p) => {
      const discount = ((p.inputPerMTok - p.cachedInputPerMTok!) / p.inputPerMTok * 100).toFixed(0);
      return { window: p.completionWindow, discount };
    }) ?? [],
  );
</script>

{#if error}
  <div class="text-center py-16 text-slate-400">
    <p class="text-lg mb-2">Failed to load model</p>
    <p class="text-sm">{error}</p>
  </div>
{:else if !model}
  <div class="text-center py-16 text-slate-400">Loading…</div>
{:else}
  <div class="space-y-6">
    <!-- Back link -->
    <a
      href="#/models"
      class="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors no-underline"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      Back to models
    </a>

    <!-- Header -->
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-xl font-semibold font-mono text-slate-900">{model.id}</h1>
          {#if isResearching}
            <span class="inline-block text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">Researching…</span>
          {:else if model.supportsImage}
            <span class="inline-block text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">📷 Image</span>
          {/if}
        </div>
        {#if model.description}
          <p class="text-sm text-slate-500 max-w-2xl">{model.description}</p>
        {/if}
      </div>
      <button
        onclick={refetch}
        disabled={isResearching}
        class="text-sm px-3 py-1.5 rounded border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {isResearching ? "Researching…" : "↻ Refetch"}
      </button>
    </div>

    <!-- Core properties -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Owner</p>
        <p class="text-sm">{shortOwner(model.ownedBy)}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Context Window</p>
        <p class="font-mono text-sm select-all" title="Click to select & copy">{model.contextSize ?? '—'}</p>
        <p class="text-xs text-slate-400">{formatContextSize(model.contextSize)}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Object Type</p>
        <p class="font-mono text-sm">{model.object}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Image Support</p>
        <p class="text-sm">{model.supportsImage ? "Yes 📷" : "No"}</p>
      </div>
      {#if model.researchedAt}
        <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
          <p class="text-xs text-slate-400 mb-0.5">Researched</p>
          <p class="font-mono text-xs">{new Date(model.researchedAt).toLocaleString()}</p>
        </div>
      {/if}
      {#if model.created}
        <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
          <p class="text-xs text-slate-400 mb-0.5">Created</p>
          <p class="font-mono text-xs">{new Date(model.created * 1000).toLocaleDateString()}</p>
        </div>
      {/if}
      {#if model.source}
        <div class="bg-white border border-slate-200 rounded-lg px-4 py-3 col-span-2">
          <p class="text-xs text-slate-400 mb-0.5">Source</p>
          <a href={model.source} target="_blank" rel="noopener" class="text-sm text-blue-600 hover:text-blue-800 underline break-all">{model.source}</a>
        </div>
      {/if}
    </div>

    <!-- Pricing section -->
    {#if model.prices && model.prices.length > 0}
      <div>
        <h2 class="text-base font-semibold text-slate-800 mb-3">Pricing</h2>
        <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-slate-50 border-b border-slate-200">
                  <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Completion Window</th>
                  <th class="text-right px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Input</th>
                  <th class="text-right px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Cached Input</th>
                  <th class="text-right px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Output</th>
                  <th class="text-right px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Cache Savings</th>
                </tr>
              </thead>
              <tbody>
                {#each orderedPrices(model.prices) as price, i}
                  <tr class="border-b border-slate-100 {i % 2 === 1 ? 'bg-slate-50/30' : ''}">
                    <td class="px-4 py-2.5">
                      <span class="inline-flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full {price.completionWindow === 'asap' ? 'bg-red-400' : price.completionWindow === 'priority' ? 'bg-amber-400' : price.completionWindow === 'flex' ? 'bg-emerald-400' : 'bg-slate-400'}"></span>
                        <span class="font-medium text-slate-700">{windowLabel(price.completionWindow)}</span>
                      </span>
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs">{formatUsdPerMTok(price.inputPerMTok)}<span class="text-slate-400">/MTok</span></td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs">
                      {#if price.cachedInputPerMTok !== null}
                        {formatUsdPerMTok(price.cachedInputPerMTok)}<span class="text-slate-400">/MTok</span>
                      {:else}
                        <span class="text-slate-300">—</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs">{formatUsdPerMTok(price.outputPerMTok)}<span class="text-slate-400">/MTok</span></td>
                    <td class="px-4 py-2.5 text-right text-xs">
                      {#if price.cachedInputPerMTok !== null}
                        <span class="text-emerald-600 font-medium">{((price.inputPerMTok - price.cachedInputPerMTok) / price.inputPerMTok * 100).toFixed(0)}% cheaper</span>
                      {:else}
                        <span class="text-slate-300">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="px-4 py-2.5 bg-slate-50/50 border-t border-slate-100 text-xs text-slate-400">
            All prices in USD per 1M tokens. {formatPriceFrom(model.prices)}.
          </div>
        </div>
      </div>
    {:else}
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-6 text-center">
        <p class="text-sm text-slate-400">No pricing information available</p>
      </div>
    {/if}

    <!-- Sampling Presets section -->
    {#if model.samplingPresets && model.samplingPresets.length > 0}
      <div>
        <h2 class="text-base font-semibold text-slate-800 mb-3">Sampling Presets</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each model.samplingPresets as preset}
            <div class="bg-white border border-slate-200 rounded-lg px-4 py-3 shadow-sm">
              <div class="font-semibold text-slate-800 mb-1">{preset.name}</div>
              {#if preset.description}
                <p class="text-xs text-slate-500 mb-2">{preset.description}</p>
              {/if}
              <JsonBlock json={formatJsonParams(preset.params)} />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Raw model ID for easy copying -->
    <div class="bg-white border border-slate-200 rounded-lg px-4 py-3 flex items-center justify-between">
      <div>
        <p class="text-xs text-slate-400 mb-0.5">Model ID</p>
        <p class="font-mono text-sm text-slate-700 select-all">{model.id}</p>
      </div>
      <button
        onclick={() => navigator.clipboard.writeText(model.id)}
        class="text-xs px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer transition-colors"
      >
        Copy
      </button>
    </div>
  </div>
{/if}
