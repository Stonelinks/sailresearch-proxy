<script lang="ts">
  import { formatRelative } from "$shared/time.ts";

  let { iso }: { iso: string } = $props();
</script>

<span title={iso}>{formatRelative(iso)}</span>
