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
  polling: {
    intervalMs: intEnv("POLL_INTERVAL_MS", 1000),
    maxDurationMs: intEnv("MAX_POLL_DURATION_MS", 900_000),
    maxConcurrent: intEnv("MAX_CONCURRENT_POLLS", 10),
  },
  streaming: {
    chunkSize: intEnv("STREAM_CHUNK_SIZE", 20),
  },
  logging: {
    level: env("LOG_LEVEL", "info"),
  },
  proxyApiKey: env("PROXY_API_KEY", ""),
};
