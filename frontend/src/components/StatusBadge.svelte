<script lang="ts">
  let { status }: { status: string } = $props();

  const variants: Record<string, string> = {
    completed: "bg-emerald-50 text-emerald-700",
    failed: "bg-red-50 text-red-700",
    cancelled: "bg-slate-100 text-slate-500",
    pending: "bg-amber-50 text-amber-700",
    queued: "bg-amber-50 text-amber-700",
    running: "bg-sky-50 text-sky-700",
  };
</script>

<span
  class="inline-block px-2 py-0.5 rounded-full text-xs font-medium font-mono {variants[status] ?? 'bg-slate-100 text-slate-600'}"
>
  {status}
</span>
