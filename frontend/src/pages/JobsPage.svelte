<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchJobs,
    connectJobUpdates,
    type Job,
    type JobUpdateCallback,
  } from "../api";
  import { applyJobUpdate } from "../jobs-reducer";
  import { log } from "$shared/logger.ts";
  import StatusBadge from "../components/StatusBadge.svelte";
  import RelativeTime from "../components/RelativeTime.svelte";
  import Duration from "../components/Duration.svelte";
  import Pagination from "../components/Pagination.svelte";

  const PAGE_SIZE = 50;

  let jobs: Job[] = $state([]);
  let total = $state(0);
  let offset = $state(0);
  let statusFilter = $state("");
  let connected = $state(false);

  let page = $derived(Math.floor(offset / PAGE_SIZE) + 1);
  let totalPages = $derived(Math.max(Math.ceil(total / PAGE_SIZE), 1));

  function shortModel(model: string): string {
    const slash = model.lastIndexOf("/");
    return slash >= 0 ? model.slice(slash + 1) : model;
  }

  async function load() {
    try {
      const data = await fetchJobs({
        limit: PAGE_SIZE,
        offset,
        status: statusFilter || undefined,
      });
      jobs = data.jobs;
      total = data.total;
    } catch (e) {
      log.error("Failed to load jobs:", e);
    }
  }

  function goToJob(id: string) {
    window.location.hash = `#/job/${id}`;
  }

  const handleJobUpdate: JobUpdateCallback = (updatedJob) => {
    const { state, action } = applyJobUpdate({
      state: { jobs, total },
      updatedJob,
      statusFilter,
      offset,
      pageSize: PAGE_SIZE,
    });
    if (action !== "ignored") {
      log.debug("Job update", action, updatedJob.id, "→", updatedJob.status);
      jobs = state.jobs;
      total = state.total;
    }
  };

  onMount(() => {
    load();
    let firstConnect = true;
    const disconnect = connectJobUpdates(
      (job) => {
        handleJobUpdate(job);
      },
      () => {
        // Resync on every reconnect: any updates that fired while the WS was
        // down were dropped, so the local state is stale. Skip the very first
        // connect since onMount already called load().
        if (!firstConnect) {
          log.debug("WS reconnected, resyncing jobs");
          load();
        }
        firstConnect = false;
        connected = true;
      },
      () => {
        connected = false;
      },
    );

    return () => disconnect();
  });
</script>

<div class="space-y-4">
  <!-- Controls -->
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div class="flex items-center gap-2">
      <label for="status-filter" class="text-sm text-slate-500">Status:</label>
      <select
        id="status-filter"
        bind:value={statusFilter}
        onchange={() => { offset = 0; load(); }}
        class="text-sm px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-300 cursor-pointer"
      >
        <option value="">All</option>
        <option value="pending">Pending</option>
        <option value="queued">Queued</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>
    <div class="flex items-center gap-2 text-sm text-slate-400">
      <span class="inline-block w-1.5 h-1.5 rounded-full {connected ? 'bg-emerald-400' : 'bg-slate-300'}"></span>
      {connected ? "Live" : "Connecting…"}
    </div>
  </div>

  <!-- Table -->
  <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-slate-50 border-b border-slate-200">
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Status</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Model</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Window</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">API</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Created</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Duration</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">Polls</th>
            <th class="text-left px-4 py-2.5 font-semibold text-slate-600 whitespace-nowrap">ID</th>
          </tr>
        </thead>
        <tbody>
          {#if jobs.length === 0}
            <tr>
              <td colspan="8" class="text-center py-10 text-slate-400">No requests found.</td>
            </tr>
          {:else}
            {#each jobs as job (job.id)}
              <tr
                class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                onclick={() => goToJob(job.id)}
                role="link"
                tabindex="0"
                onkeydown={(e) => { if (e.key === "Enter") goToJob(job.id); }}
              >
                <td class="px-4 py-2.5"><StatusBadge status={job.status} /></td>
                <td class="px-4 py-2.5 max-w-[200px] truncate" title={job.model}>{shortModel(job.model)}</td>
                <td class="px-4 py-2.5 font-mono text-xs">{job.completionWindow}</td>
                <td class="px-4 py-2.5 font-mono text-xs text-slate-500">{job.apiType}</td>
                <td class="px-4 py-2.5"><RelativeTime iso={job.createdAt} /></td>
                <td class="px-4 py-2.5"><Duration ms={job.durationMs} status={job.status} /></td>
                <td class="px-4 py-2.5 font-mono text-xs">{job.pollCount}</td>
                <td class="px-4 py-2.5 font-mono text-xs text-slate-400" title={job.sailResponseId}>{job.id.slice(0, 8)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Pagination -->
  {#if total > 0}
    <Pagination
      {page}
      {totalPages}
      {total}
      onPrev={() => { offset = Math.max(offset - PAGE_SIZE, 0); load(); }}
      onNext={() => { offset += PAGE_SIZE; load(); }}
    />
  {/if}
</div>
