<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { graphql } from "$houdini";
  import {
    shortOwner,
    formatContextSize,
    formatUsdPerMTok,
  } from "../format";
  import { log } from "$shared/logger.ts";
  import { onWsConnected } from "../lib/houdini-client";

  let search = $state("");
  let view = $state<"grid" | "table">("grid");

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
        supportedWindows
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
        supportedWindows
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
        supportedWindows
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
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          (m.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
          shortOwner(m.ownedBy).toLowerCase().includes(search.toLowerCase()),
        )
      : models,
  );

  // True when any research is happening (per-model or batch)
  let anyResearching = $derived(researchingIds.size > 0);

  let researchAllLabel = $derived(
    batchProgress
      ? `${batchProgress.completed + batchProgress.errors}/${batchProgress.total}`
      : "Research All",
  );

  const WINDOW_COLORS: Record<string, string> = {
    asap: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/25",
    priority: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25",
    standard: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/25",
    flex: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  };

  function cheapestInput(prices: Array<{ inputPerMTok: number }> | null | undefined): string {
    if (!prices || prices.length === 0) return "—";
    let min = prices[0]!.inputPerMTok;
    for (const p of prices) if (p.inputPerMTok < min) min = p.inputPerMTok;
    return formatUsdPerMTok(min);
  }

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
      const result = await ResearchAllModels.mutate(null);
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

<div class="models-page">
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <h2 class="page-title">Models</h2>
      <span class="model-count">{filtered.length}</span>
    </div>
    <div class="toolbar-right">
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.396l4.076 4.076a.75.75 0 01-1.06 1.06l-4.076-4.076A7 7 0 012 9z" clip-rule="evenodd"/>
        </svg>
        <input
          type="text"
          bind:value={search}
          placeholder="Search models…"
          class="search-input"
        />
      </div>

      <div class="view-toggle">
        <button
          class="toggle-btn {view === 'grid' ? 'active' : ''}"
          onclick={() => view = 'grid'}
          aria-label="Grid view"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" class="toggle-icon">
            <path d="M5.5 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM14.5 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM5.5 12a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM14.5 12a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
          </svg>
        </button>
        <button
          class="toggle-btn {view === 'table' ? 'active' : ''}"
          onclick={() => view = 'table'}
          aria-label="Table view"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" class="toggle-icon">
            <path fill-rule="evenodd" d="M1 4.75A.75.75 0 011.75 4h16.5a.75.75 0 010 1.5H1.75A.75.75 0 011 4.75zM1 10a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H1.75A.75.75 0 011 10zm0 5.25a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H1.75a.75.75 0 01-.75-.75z" clip-rule="evenodd"/>
          </svg>
        </button>
      </div>

      <button
        onclick={researchAll}
        disabled={anyResearching}
        class="research-btn"
      >
        {#if anyResearching && batchProgress}
          <div class="progress-ring">
            <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray={50.265 * (batchProgress.completed + batchProgress.errors) / batchProgress.total + ' 50.265'} transform="rotate(-90 10 10)"/></svg>
          </div>
          <span>{batchProgress.completed + batchProgress.errors}/{batchProgress.total}</span>
        {:else}
          <svg viewBox="0 0 20 20" fill="currentColor" class="research-icon">
            <path fill-rule="evenodd" d="M4 2a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2H4zm1.5 5a.75.75 0 000 1.5h9a.75.75 0 000-1.5h-9zm0 3.5a.75.75 0 000 1.5h5a.75.75 0 000-1.5h-5z" clip-rule="evenodd"/>
          </svg>
          <span>Research All</span>
        {/if}
      </button>
    </div>
  </div>

  {#if loading && models.length === 0}
    <div class="empty-state">
      <div class="pulse-dot"></div>
      <p>Loading models…</p>
    </div>
  {:else if error}
    <div class="empty-state error">
      <p class="error-title">Failed to load models</p>
      <p class="error-msg">{error}</p>
    </div>
  {:else if view === 'grid'}
    <div class="model-grid">
      {#each filtered as model, i (model.id)}
        <a
          href="#/models/{encodeURIComponent(model.id)}"
          class="model-card {researchingIds.has(model.id) ? 'researching' : ''}"
          style="--delay:{i * 30}ms"
        >
          <div class="card-header">
            <div class="card-identity">
              <span class="card-owner">{shortOwner(model.ownedBy)}</span>
              <span class="card-sep">/</span>
              <span class="card-name">{model.id.split('/').pop()}</span>
            </div>
            <div class="card-badges">
              {#if researchingIds.has(model.id)}
                <span class="badge badge-researching">Researching…</span>
              {:else if !model.contextSize}
                <span class="badge badge-unresearched">Unresearched</span>
              {/if}
              {#if model.supportsImage}
                <span class="badge badge-image" title="Image input">📷</span>
              {/if}
              {#if model.reasoning}
                <span class="badge badge-reasoning" title="Reasoning model">🧠</span>
              {/if}
            </div>
          </div>

          {#if model.description}
            <p class="card-desc">{model.description}</p>
          {/if}

          <div class="card-meta">
            {#if model.contextSize}
              <div class="meta-item">
                <span class="meta-label">Context</span>
                <span class="meta-value mono">{formatContextSize(model.contextSize)}</span>
              </div>
            {/if}
            {#if model.prices && model.prices.length > 0}
              <div class="meta-item">
                <span class="meta-label">From</span>
                <span class="meta-value mono">{cheapestInput(model.prices)}/M</span>
              </div>
            {/if}
            {#if model.samplingPresets && model.samplingPresets.length > 0}
              <div class="meta-item">
                <span class="meta-label">Presets</span>
                <span class="meta-value">{model.samplingPresets.length}</span>
              </div>
            {/if}
          </div>

          {#if model.supportedWindows && model.supportedWindows.length > 0}
            <div class="card-windows">
              {#each model.supportedWindows as w}
                <span class="window-pill {WINDOW_COLORS[w] ?? ''}">{w}</span>
              {/each}
            </div>
          {/if}

          <div class="card-action">
            <span>View details →</span>
          </div>
        </a>
      {/each}

      {#if filtered.length === 0}
        <div class="empty-grid">
          <p>No models match your search.</p>
        </div>
      {/if}
    </div>
  {:else}
    <div class="model-table-wrap">
      <table class="model-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Context</th>
            <th>Features</th>
            <th>Windows</th>
            <th>From</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as model (model.id)}
            <tr
              class="table-row {researchingIds.has(model.id) ? 'researching' : ''}"
              onclick={() => { window.location.hash = `/models/${encodeURIComponent(model.id)}`; }}
            >
              <td>
                <div class="table-model-id">
                  <span class="table-owner">{shortOwner(model.ownedBy)}/</span>
                  <span class="table-name">{model.id.split('/').pop()}</span>
                  {#if researchingIds.has(model.id)}
                    <span class="badge badge-researching ml-2">Researching…</span>
                  {:else if !model.contextSize}
                    <span class="badge badge-unresearched ml-2">Unresearched</span>
                  {/if}
                </div>
                {#if model.description}
                  <div class="table-desc">{model.description}</div>
                {/if}
              </td>
              <td class="mono">{model.contextSize ? formatContextSize(model.contextSize) : '—'}</td>
              <td>
                <div class="feature-badges">
                  {#if model.supportsImage}<span class="badge badge-image">📷</span>{/if}
                  {#if model.reasoning}<span class="badge badge-reasoning">🧠</span>{/if}
                </div>
              </td>
              <td>
                {#if model.supportedWindows && model.supportedWindows.length > 0}
                  <div class="card-windows compact">
                    {#each model.supportedWindows as w}
                      <span class="window-pill {WINDOW_COLORS[w] ?? ''}">{w}</span>
                    {/each}
                  </div>
                {:else}
                  <span class="dim">—</span>
                {/if}
              </td>
              <td class="mono">{model.prices && model.prices.length > 0 ? cheapestInput(model.prices) + '/M' : '—'}</td>
              <td>
                <button
                  onclick={(e: MouseEvent) => { e.stopPropagation(); refetchOne(model.id); }}
                  disabled={researchingIds.has(model.id)}
                  class="refetch-btn"
                >
                  {researchingIds.has(model.id) ? "…" : "↻"}
                </button>
              </td>
            </tr>
          {/each}
          {#if filtered.length === 0}
            <tr><td colspan="6" class="empty-table">No models found.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  /* ── Page ────────────────────────────────────────────── */
  .models-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .page-title {
    font-size: 1.35rem;
    font-weight: 600;
    letter-spacing: -0.025em;
    color: var(--text-primary);
  }

  .model-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    font-family: "JetBrains Mono", monospace;
    border-radius: 9999px;
    background: var(--surface-accent);
    color: var(--accent);
  }

  /* ── Toolbar ─────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* ── Search ──────────────────────────────────────────── */
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.625rem;
    width: 0.875rem;
    height: 0.875rem;
    color: var(--text-tertiary);
    pointer-events: none;
  }

  .search-input {
    width: 14rem;
    padding: 0.4rem 0.75rem 0.4rem 2rem;
    font-size: 0.8rem;
    font-family: "Outfit", system-ui, sans-serif;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text-primary);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .search-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-ring);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  /* ── View Toggle ──────────────────────────────────────── */
  .view-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    background: var(--surface);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .toggle-btn.active {
    background: var(--surface-accent);
    color: var(--accent);
  }

  .toggle-btn:hover:not(.active) {
    background: var(--surface-hover);
  }

  .toggle-icon {
    width: 1rem;
    height: 1rem;
  }

  /* ── Research Button ─────────────────────────────────── */
  .research-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    font-family: "Outfit", system-ui, sans-serif;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .research-btn:hover:not(:disabled) {
    background: var(--surface-accent);
    color: var(--accent);
    border-color: var(--accent-dim);
  }

  .research-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .research-icon {
    width: 0.875rem;
    height: 0.875rem;
  }

  .progress-ring {
    width: 1rem;
    height: 1rem;
  }

  .progress-ring svg {
    width: 100%;
    height: 100%;
    color: var(--accent);
  }

  /* ── Grid ─────────────────────────────────────────────── */
  .model-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
    gap: 0.875rem;
  }

  /* ── Card ─────────────────────────────────────────────── */
  .model-card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    transition:
      border-color 0.2s,
      box-shadow 0.2s,
      transform 0.2s,
      background 0.15s;
    animation: card-in 0.35s ease both;
    animation-delay: var(--delay);
  }

  @keyframes card-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .model-card:hover {
    border-color: var(--accent-dim);
    box-shadow: 0 2px 12px var(--card-shadow);
    transform: translateY(-1px);
  }

  .model-card.researching {
    border-color: var(--accent);
    background: var(--surface-accent-faint);
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-identity {
    display: flex;
    align-items: baseline;
    gap: 0;
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.3;
    word-break: break-all;
  }

  .card-owner {
    color: var(--text-tertiary);
    font-weight: 400;
  }

  .card-sep {
    color: var(--text-tertiary);
    margin: 0 0.1em;
  }

  .card-name {
    color: var(--text-primary);
  }

  .card-badges {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .card-desc {
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--text-tertiary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-meta {
    display: flex;
    gap: 0.875rem;
    flex-wrap: wrap;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .meta-label {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-tertiary);
  }

  .meta-value {
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .meta-value.mono {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
  }

  .card-windows {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .card-windows.compact {
    gap: 0.2rem;
  }

  .window-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.45rem;
    font-size: 0.625rem;
    font-weight: 600;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid;
    border-radius: 0.25rem;
  }

  .card-action {
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--accent);
    margin-top: auto;
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 0.2s, transform 0.2s;
  }

  .model-card:hover .card-action {
    opacity: 1;
    transform: translateX(0);
  }

  /* ── Badges ──────────────────────────────────────────── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.4rem;
    font-size: 0.6rem;
    font-weight: 600;
    font-family: "Outfit", system-ui, sans-serif;
    border-radius: 0.25rem;
    border: 1px solid;
    line-height: 1.4;
  }

  .badge-researching {
    background: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.25);
    animation: pulse-badge 1.5s ease-in-out infinite;
  }

  @keyframes pulse-badge {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .badge-unresearched {
    background: rgba(245, 158, 11, 0.1);
    color: #b45309;
    border-color: rgba(245, 158, 11, 0.25);
  }

  :global(.dark) .badge-unresearched {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.25);
  }

  .badge-image {
    background: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.2);
  }

  :global(.dark) .badge-image {
    color: #60a5fa;
  }

  .badge-reasoning {
    background: rgba(168, 85, 247, 0.1);
    color: #9333ea;
    border-color: rgba(168, 85, 247, 0.2);
  }

  :global(.dark) .badge-reasoning {
    color: #c084fc;
  }

  /* ── Table View ──────────────────────────────────────── */
  .model-table-wrap {
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    overflow: hidden;
    background: var(--surface);
  }

  .model-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  .model-table thead {
    background: var(--surface-alt);
  }

  .model-table th {
    padding: 0.625rem 0.875rem;
    text-align: left;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .model-table td {
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: top;
  }

  .table-row {
    cursor: pointer;
    transition: background 0.15s;
  }

  .table-row:hover {
    background: var(--surface-hover);
  }

  .table-row.researching {
    background: var(--surface-accent-faint);
  }

  .table-model-id {
    display: flex;
    align-items: baseline;
    gap: 0;
    font-weight: 600;
  }

  .table-owner {
    color: var(--text-tertiary);
    font-weight: 400;
    font-size: 0.75rem;
  }

  .table-name {
    color: var(--text-primary);
  }

  .table-desc {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--text-tertiary);
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feature-badges {
    display: flex;
    gap: 0.25rem;
  }

  .refetch-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: var(--text-tertiary);
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .refetch-btn:hover:not(:disabled) {
    background: var(--surface-accent);
    color: var(--accent);
  }

  .refetch-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dim {
    color: var(--text-tertiary);
  }

  .mono {
    font-family: "JetBrains Mono", monospace;
  }

  /* ── Empty States ─────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 3rem 1rem;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  .empty-state.error {
    color: #ef4444;
  }

  .error-title {
    font-size: 1rem;
    font-weight: 600;
  }

  .error-msg {
    font-size: 0.8rem;
  }

  .pulse-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 0.3; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.2); }
  }

  .empty-grid {
    grid-column: 1 / -1;
    text-align: center;
    padding: 2.5rem 1rem;
    color: var(--text-tertiary);
    font-size: 0.8rem;
  }

  .empty-table {
    text-align: center;
    padding: 2rem;
    color: var(--text-tertiary);
    font-size: 0.8rem;
  }

  /* ── CSS Variables (light) ────────────────────────────── */
  :root {
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-tertiary: #94a3b8;
    --border: #e2e8f0;
    --border-subtle: #f1f5f9;
    --surface: #ffffff;
    --surface-alt: #f8fafc;
    --surface-hover: #f8fafc;
    --accent: #0ea5e9;
    --accent-dim: rgba(14, 165, 233, 0.3);
    --accent-ring: rgba(14, 165, 233, 0.15);
    --surface-accent: rgba(14, 165, 233, 0.08);
    --surface-accent-faint: rgba(14, 165, 233, 0.04);
    --card-shadow: rgba(14, 165, 233, 0.08);
  }

  /* ── CSS Variables (dark) ─────────────────────────────── */
  :global(.dark) {
    --text-primary: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-tertiary: #64748b;
    --border: #1e293b;
    --border-subtle: #1e293b;
    --surface: #0f172a;
    --surface-alt: #1e293b;
    --surface-hover: #162033;
    --accent: #38bdf8;
    --accent-dim: rgba(56, 189, 248, 0.3);
    --accent-ring: rgba(56, 189, 248, 0.2);
    --surface-accent: rgba(56, 189, 248, 0.1);
    --surface-accent-faint: rgba(56, 189, 248, 0.05);
    --card-shadow: rgba(56, 189, 248, 0.05);
  }
</style>
