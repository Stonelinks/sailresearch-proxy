<script lang="ts">
  import { formatDuration } from "$shared/time.ts";

  let { ms, status }: { ms: number | null; status: string } = $props();
</script>

<span class={ms === null && status !== "completed" && status !== "failed" && status !== "cancelled"
    ? "text-slate-400 dark:text-slate-500"
    : ""}>
  {formatDuration(ms, status)}
</span>
