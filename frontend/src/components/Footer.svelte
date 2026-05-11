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
  <footer class="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-3 mt-auto transition-colors">
    <p class="text-center text-xs text-slate-400 dark:text-slate-500 font-mono">
      {#if version}v{version}{/if}
      {#if commit}({commit}){/if}
    </p>
  </footer>
{/if}
