<script lang="ts">
  import { onMount } from "svelte";
  import { fetchModels, type SailModel } from "../api";
  import { log } from "$shared/logger.ts";

  let models: SailModel[] = $state([]);
  let loading = $state(true);
  let error = $state("");
  let search = $state("");

  let filtered = $derived(
    search
      ? models.filter((m) =>
          m.id.toLowerCase().includes(search.toLowerCase()),
        )
      : models,
  );

  function shortOwner(owned_by: string): string {
    const slash = owned_by.lastIndexOf("/");
    return slash >= 0 ? owned_by.slice(slash + 1) : owned_by;
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
              <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Created</th>
            </tr>
          </thead>
          <tbody>
            {#if filtered.length === 0}
              <tr>
                <td colspan="3" class="text-center py-10 text-slate-400">No models found.</td>
              </tr>
            {:else}
              {#each filtered as model (model.id)}
                <tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td class="px-4 py-2.5 font-mono text-xs">{model.id}</td>
                  <td class="px-4 py-2.5 text-sm text-slate-600">{shortOwner(model.owned_by)}</td>
                  <td class="px-4 py-2.5 text-sm text-slate-500">
                    {new Date(model.created * 1000).toLocaleDateString()}
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
