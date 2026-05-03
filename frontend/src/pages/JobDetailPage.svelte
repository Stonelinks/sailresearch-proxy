<script lang="ts">
  import { onMount } from "svelte";
  import { fetchJob, connectJobUpdates, type JobDetail } from "../api";
  import { shortModel } from "../format";
  import { log } from "$shared/logger.ts";
  import StatusBadge from "../components/StatusBadge.svelte";
  import RelativeTime from "../components/RelativeTime.svelte";
  import Duration from "../components/Duration.svelte";

  let { params }: { params: { id: string } } = $props();

  let job: JobDetail | null = $state(null);
  let error = $state("");
  let activeTab = $state<"request" | "response" | "error">("request");
  // Track whether the user has interacted with the tabs so a late-arriving
  // response doesn't yank them off the tab they're reading.
  let userPickedTab = $state(false);

  async function load() {
    try {
      log.debug("Loading job", params.id);
      const fresh = await fetchJob(params.id);
      job = fresh;
      if (!userPickedTab) {
        if (fresh.errorBody) activeTab = "error";
        else if (fresh.responseBody) activeTab = "response";
      }
    } catch (e: any) {
      log.error("Failed to load job", params.id, ":", e);
      error = e.message ?? "Failed to load job";
    }
  }

  function pickTab(tab: "request" | "response" | "error") {
    activeTab = tab;
    userPickedTab = true;
  }

  onMount(() => {
    load();
    // Subscribe to job updates; refetch on any update for this job. The WS
    // payload omits requestBody/responseBody/errorBody, so we need a full
    // fetchJob to pick up bodies once the job completes. Also resync on
    // reconnect in case we missed the terminal update while disconnected.
    let firstConnect = true;
    const disconnect = connectJobUpdates(
      (updated) => {
        if (updated.id === params.id) {
          log.debug("Detail page got update for", params.id, "→", updated.status);
          load();
        }
      },
      () => {
        if (!firstConnect) {
          log.debug("WS reconnected, refetching job detail");
          load();
        }
        firstConnect = false;
      },
    );

    return () => disconnect();
  });

  function formatJson(raw: string | null): string {
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }
</script>

{#if error}
  <div class="text-center py-16 text-slate-400">
    <p class="text-lg mb-2">Failed to load job</p>
    <p class="text-sm">{error}</p>
  </div>
{:else if !job}
  <div class="text-center py-16 text-slate-400">Loading…</div>
{:else}
  <div class="space-y-6">
    <!-- Back link -->
    <a
      href="/#/"
      class="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors no-underline"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      Back to jobs
    </a>

    <!-- Header -->
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-xl font-semibold">{shortModel(job.model)}</h1>
          <StatusBadge status={job.status} />
        </div>
        <p class="font-mono text-xs text-slate-400">{job.id}</p>
      </div>
      <div class="text-right text-sm text-slate-500">
        <p>Sail Response: <span class="font-mono text-xs">{job.sailResponseId.slice(0, 16)}…</span></p>
      </div>
    </div>

    <!-- Details grid -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Window</p>
        <p class="font-mono text-sm">{job.completionWindow}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">API Type</p>
        <p class="font-mono text-sm">{job.apiType}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Created</p>
        <p class="text-sm"><RelativeTime iso={job.createdAt} /></p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Duration</p>
        <p class="text-sm"><Duration ms={job.durationMs} status={job.status} /></p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Poll Count</p>
        <p class="font-mono text-sm">{job.pollCount}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Model</p>
        <p class="text-sm truncate" title={job.model}>{job.model}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Created At</p>
        <p class="font-mono text-xs">{new Date(job.createdAt).toLocaleString()}</p>
      </div>
      <div class="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <p class="text-xs text-slate-400 mb-0.5">Completed At</p>
        <p class="font-mono text-xs">{job.completedAt ? new Date(job.completedAt).toLocaleString() : "—"}</p>
      </div>
    </div>

    <!-- Body tabs -->
    <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div class="flex border-b border-slate-200 bg-slate-50">
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'request' ? 'text-slate-900 border-b-2 border-slate-900 bg-white' : 'text-slate-400 hover:text-slate-600'}"
          onclick={() => pickTab('request')}
        >
          Request
        </button>
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'response' ? 'text-slate-900 border-b-2 border-slate-900 bg-white' : 'text-slate-400 hover:text-slate-600'}"
          onclick={() => pickTab('response')}
        >
          Response
          {#if job.responseBody}
            <span class="ml-1 text-xs text-emerald-500">✓</span>
          {/if}
        </button>
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'error' ? 'text-slate-900 border-b-2 border-slate-900 bg-white' : 'text-slate-400 hover:text-slate-600'}"
          onclick={() => pickTab('error')}
        >
          Error
          {#if job.errorBody}
            <span class="ml-1 text-xs text-red-500">✓</span>
          {/if}
        </button>
      </div>

      <div class="relative">
        {#if activeTab === "request" && job.requestBody}
          <button
            onclick={() => copyToClipboard(formatJson(job.requestBody!))}
            class="absolute top-3 right-3 text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded border border-slate-200 bg-white transition-colors cursor-pointer"
          >
            Copy
          </button>
          <pre class="p-4 overflow-x-auto text-xs font-mono text-slate-700 leading-relaxed">{formatJson(job.requestBody)}</pre>
        {:else if activeTab === "response" && job.responseBody}
          <button
            onclick={() => copyToClipboard(formatJson(job.responseBody!))}
            class="absolute top-3 right-3 text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded border border-slate-200 bg-white transition-colors cursor-pointer"
          >
            Copy
          </button>
          <pre class="p-4 overflow-x-auto text-xs font-mono text-slate-700 leading-relaxed">{formatJson(job.responseBody)}</pre>
        {:else if activeTab === "error" && job.errorBody}
          <pre class="p-4 overflow-x-auto text-xs font-mono text-red-600 leading-relaxed">{job.errorBody}</pre>
        {:else}
          <p class="p-4 text-sm text-slate-400">No data available.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
