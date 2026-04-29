/**
 * Integration test: starts a real proxy server with a temp DB on a random
 * port, then sends requests through each completion window and verifies
 * the response is not an error.
 *
 * By default (`bun test`), only fast passthrough (asap) tests run.
 * Set SAIL_SLOW_INTEGRATION=1 to also test the batched windows
 * (priority/standard/flex), which wait for Sail to process and can take
 * several minutes each.
 *
 * Requires:
 *   - SAIL_API_KEY in the environment
 *   - `pi` on PATH (for CLI smoke test)
 *   - network access to api.sailresearch.com
 *
 * Skipped entirely if SAIL_API_KEY is not set.
 */
import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { CompletionWindow } from "./types.ts";

// ── Temp dir & DB path ──────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "sail-proxy-test-"));
const dbPath = join(tmpDir, "proxy.db");

// ── App handle (set in beforeAll) ───────────────────────────────────────────

let app: any = null;
let baseUrl: string;

// ── Config ──────────────────────────────────────────────────────────────────

const hasApiKey = !!process.env.SAIL_API_KEY;
const runSlow = process.env.SAIL_SLOW_INTEGRATION === "1";

const TEST_MODEL = "MiniMaxAI/MiniMax-M2.7";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a chat completions request via fetch. Includes the same fields pi
 * sends (store, stream_options, etc.) to verify they get properly stripped.
 */
async function sendChatCompletion(
  window: CompletionWindow,
): Promise<{ status: number; body: any }> {
  let url: string;
  if (window === "standard") {
    url = `${baseUrl}/v1/chat/completions`;
  } else {
    url = `${baseUrl}/${window}/v1/chat/completions`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "say hi" }],
      max_tokens: 32,
      // Pi sends these — verify they get stripped in passthrough
      store: false,
      stream_options: { include_usage: true },
      prompt_cache_key: "test-session",
      stream: false,
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Run pi headlessly against a specific provider/base URL configuration.
 * Uses PI_CODING_AGENT_DIR to point pi at a temp directory with a custom
 * models.json that routes to our test proxy.
 */
async function runPiSmoke(
  window: CompletionWindow,
): Promise<{ exitCode: number; output: string }> {
  let providerBaseUrl: string;
  if (window === "standard") {
    providerBaseUrl = `${baseUrl}/v1`;
  } else {
    providerBaseUrl = `${baseUrl}/${window}/v1`;
  }

  const providerName = "sail-test";
  const modelsJson = {
    providers: {
      [providerName]: {
        baseUrl: providerBaseUrl,
        api: "openai-completions",
        apiKey: process.env.SAIL_API_KEY!,
        models: [{ id: TEST_MODEL }],
      },
    },
  };

  const agentDir = join(tmpDir, `pi-agent-${window}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(modelsJson, null, 2),
  );

  // Copy the real auth.json if it exists so pi doesn't try to re-auth
  const realAuthJson = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(realAuthJson)) {
    copyFileSync(realAuthJson, join(agentDir, "auth.json"));
  }

  // Copy settings.json if it exists
  const realSettingsJson = join(homedir(), ".pi", "agent", "settings.json");
  if (existsSync(realSettingsJson)) {
    copyFileSync(realSettingsJson, join(agentDir, "settings.json"));
  }

  const proc = Bun.spawn(
    [
      "pi",
      "-p",
      "--no-session",
      "--provider",
      providerName,
      "--model",
      TEST_MODEL,
      "say hi",
    ],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, output: stdout + stderr };
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!hasApiKey)("integration: proxy + Sail API", () => {
  beforeAll(async () => {
    // Set DATABASE_URL for our temp PrismaClient (must happen before import)
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.LOG_LEVEL = "warn";
    process.env.POLL_INTERVAL_MS = "500";
    process.env.DEFAULT_COMPLETION_WINDOW = "standard";
    process.env.PROXY_API_KEY = "";

    // Run prisma migration against temp DB
    const migrateResult = Bun.spawnSync(
      ["bunx", "prisma", "db", "push", "--skip-generate"],
      {
        env: {
          ...process.env,
          DATABASE_URL: `file:${dbPath}`,
        },
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (migrateResult.exitCode !== 0) {
      throw new Error(
        `prisma db push failed: ${migrateResult.stderr.toString()}`,
      );
    }

    // Import app module AFTER env vars are set
    const { PrismaClient } = await import("@prisma/client");
    const { createApp } = await import("./app.ts");

    const prisma = new PrismaClient();
    app = createApp(prisma, 0); // port 0 = random available port
    baseUrl = `http://localhost:${app.server.port}`;
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.stop();
      // Small delay to let the poller's in-flight tick complete
      await new Promise((r) => setTimeout(r, 100));
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Fast passthrough tests (always run) ─────────────────────────────────

  describe("asap (passthrough)", () => {
    test("returns 200, not 400 store=false", async () => {
      const { status, body } = await sendChatCompletion("asap");
      expect(status).toBe(200);
      expect(body.choices?.[0]?.message?.content).toBeDefined();
    }, 60_000);

    test("does not forward store=false to Sail", async () => {
      const { status, body } = await sendChatCompletion("asap");
      expect(status).not.toBe(400);
      const errMsg =
        typeof body?.error?.message === "string" ? body.error.message : "";
      expect(errMsg).not.toContain("store=false");
    }, 60_000);
  });

  // ── pi CLI smoke test (always run) ──────────────────────────────────────

  describe("pi CLI smoke test", () => {
    test("asap window via pi returns successfully", async () => {
      const { exitCode, output } = await runPiSmoke("asap");
      expect(output).not.toContain("store=false");
      expect(exitCode).toBe(0);
    }, 60_000);
  });

  // ── Slow batched-window tests (opt-in) ──────────────────────────────────

  describe.skipIf(!runSlow)("batched windows (priority/standard/flex)", () => {
    test("priority window returns 200", async () => {
      const { status, body } = await sendChatCompletion("priority");
      expect(status).toBe(200);
      expect(body.choices?.[0]?.message?.content).toBeDefined();
    }, 300_000);

    test("standard window returns 200", async () => {
      const { status, body } = await sendChatCompletion("standard");
      expect(status).toBe(200);
      expect(body.choices?.[0]?.message?.content).toBeDefined();
    }, 300_000);

    test("flex window returns 200", async () => {
      const { status, body } = await sendChatCompletion("flex");
      expect(status).toBe(200);
      expect(body.choices?.[0]?.message?.content).toBeDefined();
    }, 600_000);
  });
});
