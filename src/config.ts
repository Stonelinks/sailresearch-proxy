import type { CompletionWindow } from "./types.ts";
import {
  SECOND,
  MINUTE,
  FIVE_MINUTES,
  FIFTEEN_MINUTES,
  SIXTY_MINUTES,
} from "./time.ts";

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
    model: env("DEFAULT_MODEL", "deepseek-ai/DeepSeek-V3.2"),
  },
  windowTimeouts: {
    priority: intEnv("TIMEOUT_PRIORITY_MS", FIVE_MINUTES),
    standard: intEnv("TIMEOUT_STANDARD_MS", FIFTEEN_MINUTES),
    flex: intEnv("TIMEOUT_FLEX_MS", SIXTY_MINUTES),
  },
  polling: {
    intervalMs: intEnv("POLL_INTERVAL_MS", SECOND),
    maxConcurrent: intEnv("MAX_CONCURRENT_POLLS", 10),
  },
  streaming: {
    chunkSize: intEnv("STREAM_CHUNK_SIZE", 20),
  },
  prune: {
    retentionDays: intEnv("PRUNE_RETENTION_DAYS", 180),
    intervalMs: intEnv("PRUNE_INTERVAL_MS", SIXTY_MINUTES),
  },
  logging: {
    level: env("LOG_LEVEL", "info"),
  },
  proxyApiKey: env("PROXY_API_KEY", ""),
};

export function getTimeoutMs(window: CompletionWindow): number {
  if (window === "asap") return 0; // passthrough — no polling timeout
  return config.windowTimeouts[window];
}
