/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $shared: path.resolve(__dirname, "../shared"),
    },
    // Use Svelte's browser entry under jsdom — without this, vitest pulls
    // the SSR build and component mount() throws "lifecycle_function_unavailable".
    conditions: ["browser"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": { target: "ws://localhost:4000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test-setup.ts"],
  },
});
