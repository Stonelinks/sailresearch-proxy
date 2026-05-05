<script lang="ts">
  import Router from "svelte-spa-router";
  import JobsPage from "./pages/JobsPage.svelte";
  import JobDetailPage from "./pages/JobDetailPage.svelte";
  import ModelsPage from "./pages/ModelsPage.svelte";
  import ModelDetailPage from "./pages/ModelDetailPage.svelte";

  const routes = {
    "/": JobsPage,
    "/job/:id": JobDetailPage,
    "/models": ModelsPage,
    "/models/:id": ModelDetailPage,
  };
</script>

<div class="min-h-screen bg-slate-50 text-slate-900 font-sans">
  <header class="border-b border-slate-200 bg-white">
    <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
      <a href="#/" class="flex items-center gap-2 no-underline text-inherit">
        <span class="text-lg font-semibold tracking-tight">Sail Proxy</span>
        <span class="text-xs font-mono text-slate-400 bg-slate-100 rounded px-1.5 py-0.5"
          >dashboard</span
        >
      </a>
      <nav class="flex items-center gap-4 text-sm">
        <a href="#/" class="text-slate-500 hover:text-slate-700 no-underline transition-colors">Jobs</a>
        <a href="#/models" class="text-slate-500 hover:text-slate-700 no-underline transition-colors">Models</a>
      </nav>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6">
    <Router {routes} />
  </main>
</div>
