<script lang="ts">
  import { onMount } from "svelte";

  type Theme = "light" | "dark" | "system";

  let currentTheme = $state<Theme>("system");
  let resolvedDark = $state(false);

  function applyTheme(theme: Theme) {
    currentTheme = theme;
    localStorage.setItem("theme", theme);

    const isDark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

    resolvedDark = isDark;
    document.documentElement.classList.toggle("dark", isDark);
  }

  function cycleTheme() {
    const next: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
    applyTheme(next[currentTheme]);
  }

  let mediaQuery: MediaQueryList | undefined;

  onMount(() => {
    // Sync initial state from what the inline script set
    const stored = localStorage.getItem("theme") as Theme | null;
    currentTheme = stored ?? "system";
    resolvedDark = document.documentElement.classList.contains("dark");

    // Listen for system preference changes when in "system" mode
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (currentTheme === "system") {
        resolvedDark = e.matches;
        document.documentElement.classList.toggle("dark", e.matches);
      }
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery!.removeEventListener("change", handler);
  });
</script>

<button
  onclick={cycleTheme}
  title="Theme: {currentTheme}"
  class="relative w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-700 cursor-pointer transition-colors"
  aria-label="Toggle theme"
>
  <!-- Sun icon (visible when dark) -->
  <svg
    class="w-4 h-4 transition-opacity {resolvedDark ? 'opacity-100' : 'opacity-0'} absolute"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
    />
  </svg>
  <!-- Moon icon (visible when light) -->
  <svg
    class="w-4 h-4 transition-opacity {resolvedDark ? 'opacity-0' : 'opacity-100'} absolute"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
    />
  </svg>
  <!-- System indicator dot -->
  {#if currentTheme === "system"}
    <span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-400 ring-1 ring-white dark:ring-slate-800"></span>
  {/if}
</button>
