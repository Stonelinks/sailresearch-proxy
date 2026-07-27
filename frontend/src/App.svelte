<script lang="ts">
  import Router from "svelte-spa-router";
  import ModelsPage from "./pages/ModelsPage.svelte";
  import ModelDetailPage from "./pages/ModelDetailPage.svelte";
  import Footer from "./components/Footer.svelte";
  import ThemeToggle from "./components/ThemeToggle.svelte";

  const routes = {
    "/": ModelsPage,
    "/models": ModelsPage,
    "/models/:id": ModelDetailPage,
  };
</script>

<div class="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans transition-colors duration-200">
  <header class="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-colors duration-200">
    <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
      <a href="#/" class="flex items-center gap-2 no-underline text-inherit">
        <span class="text-lg font-semibold tracking-tight">Sail Proxy</span>
        <span class="text-xs font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5"
          >dashboard</span
        >
      </a>
      <div class="flex items-center gap-3">
        <nav class="flex items-center gap-4 text-sm">
          <a href="#/models" class="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 no-underline transition-colors">Models</a>
        </nav>
        <div class="border-l border-slate-200 dark:border-slate-700 pl-3">
          <ThemeToggle />
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6">
    <Router {routes} />
  </main>

  <Footer />
</div>
