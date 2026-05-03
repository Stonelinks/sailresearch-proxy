<script lang="ts">
  import { SECOND, MINUTE, HOUR, DAY } from "$shared/time.ts";

  let { iso }: { iso: string } = $props();

  function relative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / SECOND);
    if (s < 5) return "just now";
    if (s < MINUTE / SECOND) return `${s}s ago`;
    const m = Math.floor(s / (MINUTE / SECOND));
    if (m < HOUR / MINUTE) return `${m}m ago`;
    const h = Math.floor(m / (HOUR / MINUTE));
    if (h < DAY / HOUR) return `${h}h ago`;
    const d = Math.floor(h / (DAY / HOUR));
    return `${d}d ago`;
  }
</script>

<span title={iso}>{relative(iso)}</span>
