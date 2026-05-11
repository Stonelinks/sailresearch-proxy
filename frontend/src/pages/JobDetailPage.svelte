<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { graphql } from "$houdini";
  import { onWsConnected } from "../lib/houdini-client";
  import { shortModel } from "../format";
  import { log } from "$shared/logger.ts";
  import StatusBadge from "../components/StatusBadge.svelte";
  import RelativeTime from "../components/RelativeTime.svelte";
  import Duration from "../components/Duration.svelte";
  import JsonBlock from "../components/JsonBlock.svelte";

  let { params }: { params: { id: string } } = $props();

  let activeTab = $state<"request" | "response" | "error">("request");
  // Track whether the user has interacted with the tabs so a late-arriving
  // response doesn't yank them off the tab they're reading.
  let userPickedTab = $state(false);

  const JobQ = graphql(`
    query JobDetailQuery($id: ID!) {
      job(id: $id) {
        id
        sailResponseId
        status
        model
        completionWindow
        apiType
        createdAt
        completedAt
        durationMs
        pollCount
        hasError
        requestBody
        responseBody
        errorBody
      }
    }
  `);

  const JobUpdated = graphql(`
    subscription JobDetailUpdates($id: ID!) {
      jobUpdated(id: $id) {
        id
        status
      }
    }
  `);

  let job = $derived($JobQ.data?.job ?? null);
  let error = $derived($JobQ.errors?.[0]?.message ?? "");

  async function load() {
    log.debug("Loading job", params.id);
    await JobQ.fetch({ variables: { id: params.id } });
    const fresh = $JobQ.data?.job;
    if (fresh && !userPickedTab) {
      if (fresh.errorBody) activeTab = "error";
      else if (fresh.responseBody) activeTab = "response";
    }
  }

  function pickTab(tab: "request" | "response" | "error") {
    activeTab = tab;
    userPickedTab = true;
  }

  // Refetch when the subscription reports a state change for THIS job.
  // The subscription payload is intentionally minimal (just id + status)
  // because the bodies aren't published — they live only in the DB.
  $effect(() => {
    const update = $JobUpdated.data?.jobUpdated;
    if (!update || update.id !== untrack(() => params.id)) return;
    log.debug("Detail page got update for", params.id, "→", update.status);
    load();
  });

  onMount(() => {
    load();
    JobUpdated.listen({ id: params.id });
    let firstConnect = true;
    const offWs = onWsConnected(() => {
      if (firstConnect) {
        firstConnect = false;
        return;
      }
      log.debug("WS reconnected, refetching job detail");
      load();
    });
    return () => {
      offWs();
      JobUpdated.unlisten();
    };
  });


</script>

{#if error}
  <div class="text-center py-16 text-slate-400 dark:text-slate-500">
    <p class="text-lg mb-2">Failed to load job</p>
    <p class="text-sm">{error}</p>
  </div>
{:else if !job}
  <div class="text-center py-16 text-slate-400 dark:text-slate-500">Loading…</div>
{:else}
  <div class="space-y-6">
    <!-- Back link -->
    <a
      href="/#/"
      class="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors no-underline"
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
        <p class="font-mono text-xs text-slate-400 dark:text-slate-500">{job.id}</p>
      </div>
      <div class="text-right text-sm text-slate-500 dark:text-slate-400">
        <p>Sail Response: <span class="font-mono text-xs">{job.sailResponseId.slice(0, 16)}…</span></p>
      </div>
    </div>

    <!-- Details grid -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Window</p>
        <p class="font-mono text-sm">{job.completionWindow}</p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">API Type</p>
        <p class="font-mono text-sm">{job.apiType}</p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Created</p>
        <p class="text-sm"><RelativeTime iso={job.createdAt} /></p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Duration</p>
        <p class="text-sm"><Duration ms={job.durationMs} status={job.status} /></p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Poll Count</p>
        <p class="font-mono text-sm">{job.pollCount}</p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Model</p>
        <p class="text-sm truncate" title={job.model}>{job.model}</p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Created At</p>
        <p class="font-mono text-xs">{new Date(job.createdAt).toLocaleString()}</p>
      </div>
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 transition-colors">
        <p class="text-xs text-slate-400 dark:text-slate-500 mb-0.5">Completed At</p>
        <p class="font-mono text-xs">{job.completedAt ? new Date(job.completedAt).toLocaleString() : "—"}</p>
      </div>
    </div>

    <!-- Body tabs -->
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden transition-colors">
      <div class="flex border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'request' ? 'text-slate-900 dark:text-slate-100 border-b-2 border-slate-900 dark:border-slate-100 bg-white dark:bg-slate-900' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
          onclick={() => pickTab('request')}
        >
          Request
        </button>
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'response' ? 'text-slate-900 dark:text-slate-100 border-b-2 border-slate-900 dark:border-slate-100 bg-white dark:bg-slate-900' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
          onclick={() => pickTab('response')}
        >
          Response
          {#if job.responseBody}
            <span class="ml-1 text-xs text-emerald-500">✓</span>
          {/if}
        </button>
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer {activeTab === 'error' ? 'text-slate-900 dark:text-slate-100 border-b-2 border-slate-900 dark:border-slate-100 bg-white dark:bg-slate-900' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
          onclick={() => pickTab('error')}
        >
          Error
          {#if job.errorBody}
            <span class="ml-1 text-xs text-red-500">✓</span>
          {/if}
        </button>
      </div>

      <div>
        {#if activeTab === "request" && job.requestBody}
          <JsonBlock json={job.requestBody} />
        {:else if activeTab === "response" && job.responseBody}
          <JsonBlock json={job.responseBody} />
        {:else if activeTab === "error" && job.errorBody}
          <JsonBlock json={job.errorBody} error={true} />
        {:else}
          <p class="p-4 text-sm text-slate-400 dark:text-slate-500">No data available.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
