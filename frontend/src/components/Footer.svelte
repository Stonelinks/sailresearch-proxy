<script lang="ts">
  let version = "";
  let commit = "";

  async function fetchVersion() {
    try {
      const res = await fetch("/api/version");
      if (res.ok) {
        const data = await res.json();
        version = data.version ?? "";
        commit = data.commit ?? "";
      }
    } catch {
      // Silently ignore — version display is non-essential
    }
  }

  fetchVersion();
</script>

{#if version || commit}
  <footer class="border-t border-slate-200 bg-white py-3 mt-auto">
    <p class="text-center text-xs text-slate-400 font-mono">
      {#if version}v{version}{/if}
      {#if commit}({commit}){/if}
    </p>
  </footer>
{/if}
