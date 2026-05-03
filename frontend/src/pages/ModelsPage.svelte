<script lang="ts">
  import { onMount } from "svelte";
  import { fetchModels, type SailModel, type SamplingPreset } from "../api";
  import { shortOwner, formatContextSize } from "../format";
  import { log } from "$shared/logger.ts";

  let models: SailModel[] = $state([]);
  let loading = $state(true);
  let error = $state("");
  let search = $state("");
  let expandedPresets: Set<string> = $state(new Set());

  let filtered = $derived(
    search
      ? models.filter((m) =>
          m.id.toLowerCase().includes(search.toLowerCase()),
        )
      : models,
  );

  function togglePresets(modelId: string) {
    const next = new Set(expandedPresets);
    if (next.has(modelId)) {
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    expandedPresets = next;
  }

  onMount(async () => {
    try {
      log.debug("Loading models");
      const data = await fetchModels();
      models = data.data ?? [];
    } catch (e: any) {
      log.error("Failed to load models:", e);
      error = e.message ?? "Failed to load models";
    } finally {
      loading = false;
    }
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

  {#if loading}
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
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Description</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Presets</th>
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Created</th>
            </tr>
          </thead>
          <tbody>
            {#if filtered.length === 0}
              <tr>
                <td colspan="6" class="text-center py-10 text-slate-400">No models found.</td>
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
                  <td class="px-4 py-2.5 text-sm text-slate-600">{shortOwner(model.owned_by)}</td>
                  <td class="px-4 py-2.5 text-sm text-slate-500 whitespace-nowrap">
                    {#if model.contextSize !== null}
                      <span class="font-mono text-xs">{formatContextSize(model.contextSize)}</span>
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
                    {#if model.samplingPresets && model.samplingPresets.length > 0}
                      <button
                        onclick={() => togglePresets(model.id)}
                        class="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                      >
                        {model.samplingPresets.length} preset{model.samplingPresets.length !== 1 ? 's' : ''}
                        {expandedPresets.has(model.id) ? ' ▾' : ' ▸'}
                      </button>
                    {:else}
                      <span class="text-slate-300 text-xs">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-sm text-slate-500">
                    {new Date(model.created * 1000).toLocaleDateString()}
                  </td>
                </tr>
                {#if expandedPresets.has(model.id) && model.samplingPresets && model.samplingPresets.length > 0}
                  <tr class="bg-slate-50/50">
                    <td colspan="6" class="px-4 py-3">
                      <div class="flex flex-wrap gap-2 ml-4">
                        {#each model.samplingPresets as preset}
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
