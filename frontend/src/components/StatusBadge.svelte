<script lang="ts">
  let { status }: { status: string } = $props();

  const variants: Record<string, string> = {
    completed: "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
    failed: "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400",
    cancelled: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
    pending: "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
    queued: "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
    running: "bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400",
  };
</script>

<span
  class="inline-block px-2 py-0.5 rounded-full text-xs font-medium font-mono {variants[status] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}"
>
  {status}
</span>
