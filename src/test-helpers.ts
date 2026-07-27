/**
 * Small shared utilities for backend tests. Kept intentionally narrow —
 * `mock.module(...)` calls have to happen at the top of each test file
 * (Bun loads them at import time), so we don't try to abstract those.
 *
 *   - swapConfig: save a nested config slice, replace it for a test, restore
 *     after — used by tests that point a real Bun.serve at a fake-Sail.
 */
import { config } from "./config.ts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Replace a slice of `config` for the lifetime of the returned restore
 * function. Each entry is shallow-merged into the corresponding sub-object,
 * so e.g. `swapConfig({ sail: { baseUrl: "x" } })` only affects baseUrl and
 * leaves the other sail.* fields alone.
 *
 * Use in beforeAll/afterAll pairs:
 *   const restore = swapConfig({ sail: { baseUrl, apiKey: "test" } });
 *   ...
 *   restore();
 */
export function swapConfig(overrides: DeepPartial<typeof config>): () => void {
  const saved: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(overrides)) {
    if (!fields || typeof fields !== "object") continue;
    saved[section] = {};
    const target = (config as any)[section];
    for (const key of Object.keys(fields)) {
      saved[section]![key] = target[key];
      target[key] = (fields as any)[key];
    }
  }
  return () => {
    for (const [section, fields] of Object.entries(saved)) {
      const target = (config as any)[section];
      for (const [key, value] of Object.entries(fields)) {
        target[key] = value;
      }
    }
  };
}
