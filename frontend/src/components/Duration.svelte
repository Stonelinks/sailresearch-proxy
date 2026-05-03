<script lang="ts">
  import { SECOND, MINUTE, HOUR, DAY } from "$shared/time.ts";

  let { ms, status }: { ms: number | null; status: string } = $props();

  function format(ms: number | null, status: string): string {
    if (ms === null) {
      if (status === "completed" || status === "failed" || status === "cancelled")
        return "—";
      return "in progress";
    }
    if (ms < SECOND) return `${ms}ms`;
    const s = Math.floor(ms / SECOND);
    if (s < MINUTE / SECOND) return `${s}s`;
    const m = Math.floor(s / (MINUTE / SECOND));
    return `${m}m ${s % (MINUTE / SECOND)}s`;
  }
</script>

<span class={ms === null && status !== "completed" && status !== "failed" && status !== "cancelled"
    ? "text-slate-400"
    : ""}>
  {format(ms, status)}
</span>
