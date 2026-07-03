import type { CompletionWindow } from "./types.ts";
import {
  SECOND,
  MINUTE,
  FIVE_MINUTES,
  THIRTY_MINUTES,
  SIXTY_MINUTES,
  TWO_HOURS,
} from "../shared/time.ts";
import { HEARTBEAT_INTERVAL_MS } from "./constants.ts";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

export const config = {
  sail: {
    apiKey: requireEnv("SAIL_API_KEY"),
    baseUrl: env("SAIL_BASE_URL", "https://api.sailresearch.com/v1"),
    // Tight bound for status checks and job-creation calls. These should
    // return in milliseconds; anything past 30s is a stuck socket.
    pollTimeoutMs: intEnv("SAIL_POLL_TIMEOUT_MS", 30 * SECOND),
    // Generous bound for synchronous inference passthroughs. Long enough
    // to cover most generations, short enough to bound the per-request
    // socket leak if Sail hangs.
    inferenceTimeoutMs: intEnv("SAIL_INFERENCE_TIMEOUT_MS", 5 * MINUTE),
  },
  server: {
    port: intEnv("PORT", 4000),
    host: env("HOST", "0.0.0.0"),
  },
  defaults: {
    completionWindow: env("DEFAULT_COMPLETION_WINDOW", "standard") as
      | "asap"
      | "priority"
      | "standard"
      | "flex",
    model: env("DEFAULT_MODEL", "zai-org/GLM-5.1-FP8"),
  },
  windowTimeouts: {
    priority: intEnv("TIMEOUT_PRIORITY_MS", FIVE_MINUTES),
    standard: intEnv("TIMEOUT_STANDARD_MS", THIRTY_MINUTES),
    flex: intEnv("TIMEOUT_FLEX_MS", TWO_HOURS),
  },
  polling: {
    intervalMs: intEnv("POLL_INTERVAL_MS", SECOND),
    maxConcurrent: intEnv("MAX_CONCURRENT_POLLS", 10),
  },
  research: {
    // Max models researched / smoke tested in parallel. Bounds the load
    // placed on the proxy (and Sail upstream) during batch research and
    // `generate-models-json --smoke-test`.
    maxConcurrent: intEnv("MAX_CONCURRENT_RESEARCH", 5),
    // Completion window used for pi research LLM calls and preset smoke
    // tests. asap is the passthrough path — pricier per token, but research
    // prompts are tiny and it turns 30-minute batch waits into
    // interactive-latency calls. The default model must support this window.
    window: env("RESEARCH_WINDOW", "asap") as CompletionWindow,
    // Slack added on top of a window's server-side timeout to form the
    // client-side smoke-test cap. The proxy always answers within the
    // window's own bound (success, failure, or job-timeout error), so the
    // client cap exists only to catch wedged sockets — flex jobs still get
    // their full window to complete.
    smokeTimeoutSlackMs: intEnv("SMOKE_TEST_TIMEOUT_SLACK_MS", MINUTE),
    // Max preset smoke tests in flight at once within a single model.
    presetConcurrency: intEnv("RESEARCH_PRESET_CONCURRENCY", 3),
    // Cap on docs-scraper page fetches.
    scrapeTimeoutMs: intEnv("SCRAPE_TIMEOUT_MS", 30 * SECOND),
  },
  streaming: {
    chunkSize: intEnv("STREAM_CHUNK_SIZE", 20),
    heartbeatIntervalMs: intEnv("HEARTBEAT_INTERVAL_MS", HEARTBEAT_INTERVAL_MS),
  },
  prune: {
    retentionDays: intEnv("PRUNE_RETENTION_DAYS", 180),
    intervalMs: intEnv("PRUNE_INTERVAL_MS", SIXTY_MINUTES),
  },
  logging: {
    level: env("LOG_LEVEL", "info"),
    dir: env("LOG_DIR", "data/logs"),
  },
  proxyApiKey: env("PROXY_API_KEY", ""),
};

/**
 * Polling timeout for a window. asap is intentionally excluded — it goes
 * through the passthrough path and never enters the poller, so a 0 here
 * was a footgun (immediate expiry) for any caller that accidentally passed
 * "asap". The type system now catches that at the call site.
 */
export function getTimeoutMs(
  window: Exclude<CompletionWindow, "asap">,
): number {
  return config.windowTimeouts[window];
}
