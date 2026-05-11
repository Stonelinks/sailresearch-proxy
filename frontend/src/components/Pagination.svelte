<script lang="ts">
  let {
    page,
    totalPages,
    total,
    onPrev,
    onNext,
  }: {
    page: number;
    totalPages: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  } = $props();
</script>

<div class="flex items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
  <button
    onclick={onPrev}
    disabled={page <= 1}
    class="px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default transition-colors cursor-pointer"
  >
    Prev
  </button>
  <span class="font-mono text-xs"
    >Page {page} of {totalPages} &middot; {total} total</span
  >
  <button
    onclick={onNext}
    disabled={page >= totalPages}
    class="px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default transition-colors cursor-pointer"
  >
    Next
  </button>
</div>
