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

  const WINDOW_COLORS: Record<string, string> = {
    asap: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/25",
    priority: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25",
    standard: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/25",
    flex: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  };

  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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
    mutation RefetchModelDetail($modelId: ID!) {
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

  function orderedPrices(prices: ReadonlyArray<PriceRow> | null | undefined): PriceRow[] {
    if (!prices) return [];
    const byWindow = new Map(prices.map((p) => [p.completionWindow, p]));
    return WINDOW_ORDER.map((w) => byWindow.get(w)).filter((p): p is PriceRow => !!p);
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
    const data = $ActiveResearch.data?.activeResearch;
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
      newIds.delete(update.modelId);
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

  // Thinking level helpers
  let thinkingLevelMap = $derived(() => {
    if (!model?.thinkingLevelMap) return null;
    const raw = model.thinkingLevelMap as Record<string, string | number | boolean | null>;
    const map: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" || v === null) {
        map[k] = v;
      }
    }
    return map;
  });

  let activeThinkingLevels = $derived(() => {
    const map = thinkingLevelMap();
    if (!map) return [];
    return THINKING_LEVELS.filter(
      (level) => level in map && map[level] !== null,
    ).map((level) => ({
      level,
      value: map[level]!,
    }));
  });

  // Computed: has this model been researched?
  let isResearched = $derived(model?.contextSize !== null && model?.contextSize !== undefined);
</script>

{#if error}
  <div class="detail-empty error">
    <p class="error-title">Failed to load model</p>
    <p class="error-msg">{error}</p>
  </div>
{:else if !model}
  <div class="detail-empty">
    <div class="spinner"></div>
    <p>Loading model…</p>
  </div>
{:else}
  <div class="detail-page">
    <!-- Back link -->
    <a href="#/models" class="back-link">
      <svg class="back-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      Models
    </a>

    <!-- Hero Header -->
    <header class="detail-hero">
      <div class="hero-left">
        <div class="hero-identity">
          <span class="hero-owner">{shortOwner(model.ownedBy)}</span>
          <span class="hero-sep">/</span>
          <span class="hero-name">{model.id.split('/').pop()}</span>
        </div>
        <div class="hero-full-id">{model.id}</div>
        {#if model.description}
          <p class="hero-desc">{model.description}</p>
        {/if}
        <div class="hero-badges">
          {#if isResearching}
            <span class="badge badge-researching">Researching…</span>
          {/if}
          {#if !isResearched && !isResearching}
            <span class="badge badge-unresearched">Not yet researched</span>
          {/if}
          {#if model.supportsImage}
            <span class="badge badge-image" title="Supports image input">📷 Image</span>
          {/if}
          {#if model.reasoning}
            <span class="badge badge-reasoning" title="Reasoning / chain-of-thought model">🧠 Reasoning</span>
          {/if}
          {#if model.supportedWindows && model.supportedWindows.length > 0}
            {#each model.supportedWindows as w}
              <span class="window-pill {WINDOW_COLORS[w] ?? ''}">{w}</span>
            {/each}
          {/if}
        </div>
      </div>
      <div class="hero-right">
        <button
          onclick={refetch}
          disabled={isResearching}
          class="refetch-btn"
        >
          {#if isResearching}
            <div class="btn-spinner"></div>
            Researching…
          {:else}
            <svg viewBox="0 0 20 20" fill="currentColor" class="refetch-icon">
              <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.746 2.971.75.75 0 00-1.075 1.047A7 7 0 1016.71 10.5h.79a.75.75 0 010 1.5h-2.19a.75.75 0 01-.75-.75v-2.19a.75.75 0 011.5 0v.364zm-10.624-2.848a5.5 5.5 0 019.746-2.971.75.75 0 001.075-1.047A7 7 0 003.29 9.5H2.5a.75.75 0 000 1.5h2.19a.75.75 0 00.75-.75V8.06a.75.75 0 00-1.5 0v.516z" clip-rule="evenodd"/>
            </svg>
            Refetch
          {/if}
        </button>
      </div>
    </header>

    <!-- Key Metrics -->
    <div class="metrics-row">
      <div class="metric-card">
        <span class="metric-label">Owner</span>
        <span class="metric-value">{shortOwner(model.ownedBy)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Context Window</span>
        <span class="metric-value mono">{model.contextSize ?? '—'}</span>
        {#if model.contextSize}
          <span class="metric-sub mono">{formatContextSize(model.contextSize)}</span>
        {/if}
      </div>
      <div class="metric-card">
        <span class="metric-label">Object Type</span>
        <span class="metric-value mono">{model.object}</span>
      </div>
      {#if model.researchedAt}
        <div class="metric-card">
          <span class="metric-label">Researched</span>
          <span class="metric-value mono">{new Date(model.researchedAt).toLocaleDateString()}</span>
          <span class="metric-sub">{new Date(model.researchedAt).toLocaleTimeString()}</span>
        </div>
      {/if}
      {#if model.created}
        <div class="metric-card">
          <span class="metric-label">Created</span>
          <span class="metric-value mono">{new Date(model.created * 1000).toLocaleDateString()}</span>
        </div>
      {/if}
    </div>

    <!-- Source Link -->
    {#if model.source}
      <a href={model.source} target="_blank" rel="noopener" class="source-link">
        <svg class="source-icon" viewBox="0 0 20 20" fill="currentColor">
          <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656L7.28 6.878a4 4 0 005.656 5.656.75.75 0 00-1.06-1.061 2.5 2.5 0 01-3.536-3.536l3.89-3.89z"/>
          <path d="M11.18 10.59a.75.75 0 01.732-.198 2.5 2.5 0 013.536 3.536l-3.89 3.89a2.5 2.5 0 01-3.536-3.536.75.75 0 011.06 1.06 1 1 0 001.415 1.415l3.89-3.89a1 1 0 00-1.415-1.415.75.75 0 01-1.06 0z"/>
        </svg>
        <span class="source-text">{model.source}</span>
        <svg class="source-external" viewBox="0 0 20 20" fill="currentColor">
          <path d="M6.28 5.22a.75.75 0 00-1.06 0l-2.5 2.5a.75.75 0 001.06 1.06L6.28 6.28l1.97 1.97a.75.75 0 001.06-1.06L6.28 5.22z"/>
        </svg>
      </a>
    {/if}

    <!-- Thinking Levels -->
    {#if model.reasoning && activeThinkingLevels().length > 0}
      <section class="section">
        <h3 class="section-title">Thinking Levels</h3>
        <div class="thinking-levels">
          {#each activeThinkingLevels() as { level, value }}
            <div class="thinking-card">
              <div class="thinking-level-name">{level}</div>
              <div class="thinking-level-value mono">{value}</div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Pricing -->
    {#if model.prices && model.prices.length > 0}
      <section class="section">
        <h3 class="section-title">Pricing</h3>
        <div class="pricing-table-wrap">
          <table class="pricing-table">
            <thead>
              <tr>
                <th>Window</th>
                <th class="right">Input</th>
                <th class="right">Cached</th>
                <th class="right">Output</th>
                <th class="right">Savings</th>
              </tr>
            </thead>
            <tbody>
              {#each orderedPrices(model.prices) as price, i}
                <tr class="{i % 2 === 1 ? 'alt-row' : ''}">
                  <td>
                    <span class="window-pill {WINDOW_COLORS[price.completionWindow] ?? ''}">{windowLabel(price.completionWindow)}</span>
                  </td>
                  <td class="right mono">{formatUsdPerMTok(price.inputPerMTok)}<span class="unit">/M</span></td>
                  <td class="right mono">
                    {#if price.cachedInputPerMTok !== null}
                      {formatUsdPerMTok(price.cachedInputPerMTok)}<span class="unit">/M</span>
                    {:else}
                      <span class="dim">—</span>
                    {/if}
                  </td>
                  <td class="right mono">{formatUsdPerMTok(price.outputPerMTok)}<span class="unit">/M</span></td>
                  <td class="right">
                    {#if price.cachedInputPerMTok !== null}
                      <span class="savings">{((price.inputPerMTok - price.cachedInputPerMTok) / price.inputPerMTok * 100).toFixed(0)}% off</span>
                    {:else}
                      <span class="dim">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="pricing-footer">
          All prices in USD per 1M tokens. {formatPriceFrom(model.prices)}.
        </div>
      </section>
    {:else}
      <section class="section">
        <div class="empty-section">
          <p>No pricing information available</p>
          <p class="empty-hint">Run "Research All" to fetch pricing from the Sail docs</p>
        </div>
      </section>
    {/if}

    <!-- Sampling Presets -->
    {#if model.samplingPresets && model.samplingPresets.length > 0}
      <section class="section">
        <h3 class="section-title">Sampling Presets</h3>
        <div class="presets-grid">
          {#each model.samplingPresets as preset}
            <div class="preset-card">
              <div class="preset-header">
                <span class="preset-name">{preset.name}</span>
              </div>
              {#if preset.description}
                <p class="preset-desc">{preset.description}</p>
              {/if}
              <JsonBlock json={formatJsonParams(preset.params)} maxLines={6} />
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Model ID Copy -->
    <div class="copy-bar">
      <div>
        <p class="copy-label">Model ID</p>
        <p class="copy-value mono">{model.id}</p>
      </div>
      <button
        onclick={() => navigator.clipboard.writeText(model.id)}
        class="copy-btn"
      >
        Copy
      </button>
    </div>
  </div>
{/if}

<style>
  /* ── Page Shell ──────────────────────────────────────── */
  .detail-page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* ── Back Link ───────────────────────────────────────── */
  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-tertiary);
    text-decoration: none;
    transition: color 0.15s;
  }

  .back-link:hover {
    color: var(--accent);
  }

  .back-icon {
    width: 0.875rem;
    height: 0.875rem;
  }

  /* ── Hero ─────────────────────────────────────────────── */
  .detail-hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .hero-left {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .hero-identity {
    display: flex;
    align-items: baseline;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .hero-owner {
    color: var(--text-tertiary);
    font-weight: 400;
  }

  .hero-sep {
    color: var(--text-tertiary);
    margin: 0 0.05em;
  }

  .hero-name {
    color: var(--text-primary);
  }

  .hero-full-id {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    color: var(--text-tertiary);
    margin-top: -0.25rem;
  }

  .hero-desc {
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text-secondary);
    max-width: 36rem;
  }

  .hero-badges {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  /* ── Badges ──────────────────────────────────────────── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.5rem;
    font-size: 0.65rem;
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

  .window-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.45rem;
    font-size: 0.6rem;
    font-weight: 600;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid;
    border-radius: 0.25rem;
  }

  /* ── Refetch Button ──────────────────────────────────── */
  .refetch-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.85rem;
    font-size: 0.78rem;
    font-weight: 500;
    font-family: "Outfit", system-ui, sans-serif;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .refetch-btn:hover:not(:disabled) {
    background: var(--surface-accent);
    color: var(--accent);
    border-color: var(--accent-dim);
  }

  .refetch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .refetch-icon {
    width: 0.875rem;
    height: 0.875rem;
  }

  .btn-spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Metrics Row ─────────────────────────────────────── */
  .metrics-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: 0.75rem;
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    background: var(--surface);
    transition: border-color 0.15s;
  }

  .metric-card:hover {
    border-color: var(--accent-dim);
  }

  .metric-label {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-tertiary);
  }

  .metric-value {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .metric-value.mono {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.8rem;
  }

  .metric-sub {
    font-size: 0.68rem;
    color: var(--text-tertiary);
  }

  .metric-sub.mono {
    font-family: "JetBrains Mono", monospace;
  }

  /* ── Source Link ──────────────────────────────────────── */
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 500;
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
    max-width: 100%;
  }

  .source-link:hover {
    background: var(--surface-accent);
    border-color: var(--accent-dim);
  }

  .source-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .source-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-external {
    width: 0.625rem;
    height: 0.625rem;
    flex-shrink: 0;
    opacity: 0.5;
  }

  /* ── Section ─────────────────────────────────────────── */
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  /* ── Thinking Levels ─────────────────────────────────── */
  .thinking-levels {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
    gap: 0.625rem;
  }

  .thinking-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    transition: border-color 0.15s;
  }

  .thinking-card:hover {
    border-color: rgba(168, 85, 247, 0.3);
  }

  .thinking-level-name {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: #a855f7;
  }

  :global(.dark) .thinking-level-name {
    color: #c084fc;
  }

  .thinking-level-value {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .thinking-level-value.mono {
    font-family: "JetBrains Mono", monospace;
  }

  /* ── Pricing Table ────────────────────────────────────── */
  .pricing-table-wrap {
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    overflow: hidden;
    background: var(--surface);
  }

  .pricing-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  .pricing-table thead {
    background: var(--surface-alt);
  }

  .pricing-table th {
    padding: 0.625rem 0.875rem;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    text-align: left;
  }

  .pricing-table th.right {
    text-align: right;
  }

  .pricing-table td {
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .pricing-table td.right {
    text-align: right;
  }

  .alt-row {
    background: var(--surface-alt);
  }

  .unit {
    font-size: 0.65rem;
    color: var(--text-tertiary);
    margin-left: 0.125rem;
  }

  .savings {
    font-size: 0.72rem;
    font-weight: 600;
    color: #059669;
  }

  :global(.dark) .savings {
    color: #34d399;
  }

  .dim {
    color: var(--text-tertiary);
  }

  .mono {
    font-family: "JetBrains Mono", monospace;
  }

  .pricing-footer {
    padding: 0.5rem 0.875rem;
    background: var(--surface-alt);
    border-top: 1px solid var(--border-subtle);
    font-size: 0.68rem;
    color: var(--text-tertiary);
  }

  /* ── Presets Grid ─────────────────────────────────────── */
  .presets-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    gap: 0.75rem;
  }

  .preset-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    background: var(--surface);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .preset-card:hover {
    border-color: var(--accent-dim);
    box-shadow: 0 1px 8px var(--card-shadow);
  }

  .preset-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .preset-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .preset-desc {
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--text-tertiary);
  }

  /* ── Copy Bar ────────────────────────────────────────── */
  .copy-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    background: var(--surface);
  }

  .copy-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-tertiary);
  }

  .copy-value {
    font-size: 0.8rem;
    color: var(--text-primary);
  }

  .copy-value.mono {
    font-family: "JetBrains Mono", monospace;
  }

  .copy-btn {
    padding: 0.3rem 0.65rem;
    font-size: 0.72rem;
    font-weight: 500;
    font-family: "Outfit", system-ui, sans-serif;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .copy-btn:hover {
    background: var(--surface-accent);
    color: var(--accent);
    border-color: var(--accent-dim);
  }

  /* ── Empty Sections ───────────────────────────────────── */
  .empty-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2rem 1rem;
    border: 1px dashed var(--border);
    border-radius: 0.625rem;
    text-align: center;
  }

  .empty-section p {
    font-size: 0.8rem;
    color: var(--text-tertiary);
  }

  .empty-hint {
    font-size: 0.7rem !important;
    color: var(--text-tertiary);
  }

  .detail-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 3rem 1rem;
    color: var(--text-tertiary);
    font-size: 0.85rem;
  }

  .detail-empty.error {
    color: #ef4444;
  }

  .error-title {
    font-size: 1rem;
    font-weight: 600;
  }

  .error-msg {
    font-size: 0.8rem;
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2.5px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  /* ── CSS Variables ────────────────────────────────────── */
  :root {
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-tertiary: #94a3b8;
    --border: #e2e8f0;
    --border-subtle: #f1f5f9;
    --surface: #ffffff;
    --surface-alt: #f8fafc;
    --surface-hover: #f1f5f9;
    --accent: #0ea5e9;
    --accent-dim: rgba(14, 165, 233, 0.3);
    --accent-ring: rgba(14, 165, 233, 0.15);
    --surface-accent: rgba(14, 165, 233, 0.08);
    --surface-accent-faint: rgba(14, 165, 233, 0.04);
    --card-shadow: rgba(14, 165, 233, 0.08);
  }

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
