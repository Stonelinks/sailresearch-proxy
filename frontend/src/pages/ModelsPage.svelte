<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { graphql } from "$houdini";
  import {
    shortOwner,
    formatContextSize,
    formatPriceFrom,
  } from "../format";
  import { log } from "$shared/logger.ts";
  import { onWsConnected } from "../lib/houdini-client";

  let search = $state("");

  // ── Research state (server-synced) ──────────────────────────────────────
  let researchingIds = $state<Set<string>>(new Set());

  type BatchProgress = {
    id: string;
    total: number;
    completed: number;
    errors: number;
  } | null;

  let batchProgress = $state<BatchProgress>(null);

  const ActiveResearch = graphql(`
    query ActiveResearch {
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
    subscription ModelResearchUpdates {
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

  // ── Models query & mutations ────────────────────────────────────────────

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
        supportsImage
        reasoning
        thinkingLevelMap
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
        supportsImage
        reasoning
        thinkingLevelMap
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

  const ResearchAllModels = graphql(`
    mutation ResearchAllModels {
      researchAllModels {
        id
        contextSize
        description
        source
        supportsImage
        reasoning
        thinkingLevelMap
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

  // True when any research is happening (per-model or batch)
  let anyResearching = $derived(researchingIds.size > 0);

  let researchAllLabel = $derived(() => {
    if (!batchProgress) return "Research All";
    return `Researching ${batchProgress.completed + batchProgress.errors}/${batchProgress.total}…`;
  });

  async function refetchOne(modelId: string) {
    try {
      log.debug("Refetching model", modelId);
      const result = await RefetchModel.mutate({ modelId });
      if (result.errors?.length) {
        log.error("Refetch failed:", result.errors[0].message);
        alert(`Refetch failed: ${result.errors[0].message}`);
      } else {
        log.debug("Refetched", modelId);
      }
    } catch (err) {
      log.error("Refetch failed:", err);
    }
  }

  async function researchAll() {
    try {
      log.debug("Researching all models");
      const result = await ResearchAllModels.mutate({});
      if (result.errors?.length) {
        log.error("Research all failed:", result.errors[0].message);
        alert(`Research all failed: ${result.errors[0].message}`);
      } else {
        log.debug("Researched all models");
      }
    } catch (err) {
      log.error("Research all failed:", err);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function loadResearchState() {
    await ActiveResearch.fetch();
    const data = $ActiveResearch.data?.activeResearch;
    if (data) {
      researchingIds = new Set(data.modelIds);
      batchProgress = data.batch ?? null;
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
      // "completed" or "failed" — remove from active set
      newIds.delete(update.modelId);
      // On completion, refetch models to get fresh data
      Models.fetch();
    }

    researchingIds = newIds;
    batchProgress = update.batch ?? null;
  });

  onMount(() => {
    Models.fetch();
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
      Models.fetch();
    });

    return () => {
      offWs();
      ModelResearchUpdated.unlisten();
    };
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
      <button
        onclick={researchAll}
        disabled={anyResearching}
        class="text-sm px-3 py-1.5 rounded border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {researchAllLabel()}
      </button>
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
              <th class="text-center px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Image</th>
              <th class="text-center px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Reasoning</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Price</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Description</th>
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
                <tr
                  class="border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer group"
                  onclick={() => { window.location.hash = `/models/${encodeURIComponent(model.id)}`; }}
                >
                  <td class="px-4 py-2.5 font-mono text-xs text-slate-800 group-hover:text-slate-900">
                    {model.id}
                    {#if researchingIds.has(model.id)}
                      <span class="ml-1.5 inline-block text-[10px] font-sans font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">Researching…</span>
                    {:else if model.contextSize === null}
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
                  <td class="px-4 py-2.5 text-center">
                    {#if model.supportsImage}
                      <span class="inline-block text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">📷</span>
                    {:else}
                      <span class="text-slate-300 text-xs">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-center">
                    {#if model.reasoning}
                      <span class="inline-block text-xs text-purple-600 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">🧠</span>
                    {:else}
                      <span class="text-slate-300 text-xs">—</span>
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
                  <td class="px-4 py-2.5 text-right">
                    <button
                      onclick={(e: MouseEvent) => { e.stopPropagation(); refetchOne(model.id); }}
                      disabled={researchingIds.has(model.id)}
                      class="text-xs px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {researchingIds.has(model.id) ? "Researching…" : "Refetch"}
                    </button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <p class="text-xs text-slate-400 text-center">{filtered.length} model{filtered.length !== 1 ? 's' : ''}</p>
  {/if}
</div>
