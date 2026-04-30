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
 *   - `uvx` on PATH (for Python SDK smoke tests)
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
const IMAGE_MODEL = "moonshotai/Kimi-K2.5";

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
 * Send a Responses API request via fetch.
 */
async function sendResponses(
  window: CompletionWindow,
): Promise<{ status: number; body: any }> {
  let url: string;
  if (window === "standard") {
    url = `${baseUrl}/v1/responses`;
  } else {
    url = `${baseUrl}/${window}/v1/responses`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model: TEST_MODEL,
      input: "say hi",
      max_output_tokens: 32,
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Send an Anthropic Messages API request via fetch.
 */
async function sendMessages(
  window: CompletionWindow,
): Promise<{ status: number; body: any }> {
  let url: string;
  if (window === "standard") {
    url = `${baseUrl}/v1/messages`;
  } else {
    url = `${baseUrl}/${window}/v1/messages`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Fetch dashboard jobs from the proxy's API.
 */
async function fetchDashboardJobs(): Promise<{
  jobs: any[];
  total: number;
}> {
  const res = await fetch(`${baseUrl}/api/dashboard/jobs?limit=100`);
  return (await res.json()) as { jobs: any[]; total: number };
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

/**
 * Run a Python script using `uvx` with the anthropic or openai package.
 * This avoids needing a global Python install or venv setup.
 */
async function runUvxPython(
  packages: string[],
  script: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [
    "uvx",
    ...packages.flatMap((p) => ["--from", p]),
    "python3",
    "-c",
    script,
  ];

  const proc = Bun.spawn(args, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
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

  // ── Image input tests (always run, uses asap/passthrough) ────────────────

  describe("image input (asap passthrough)", () => {
    test("chat completions with image_url returns 200", async () => {
      const url = `${baseUrl}/asap/v1/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "What is in this image? Describe briefly.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png",
                  },
                },
              ],
            },
          ],
          max_tokens: 64,
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.choices?.[0]?.message?.content).toBeDefined();
    }, 60_000);

    test("Anthropic messages with image returns 200", async () => {
      const url = `${baseUrl}/asap/v1/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          max_tokens: 64,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png",
                  },
                },
                {
                  type: "text",
                  text: "What is in this image? Describe briefly.",
                },
              ],
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.content).toBeDefined();
      expect(body.content.length).toBeGreaterThan(0);
    }, 60_000);
  });

  // ── Responses API tests (always run, asap passthrough) ──────────────────

  describe("Responses API (asap passthrough)", () => {
    test("returns 200 with valid response structure", async () => {
      const { status, body } = await sendResponses("asap");
      expect(status).toBe(200);
      expect(body.id).toBeDefined();
      expect(body.model).toBe(TEST_MODEL);
      expect(body.output).toBeDefined();
    }, 60_000);
  });

  // ── Anthropic SDK smoke tests via uvx ───────────────────────────────────

  describe("Anthropic SDK smoke test (uvx)", () => {
    test("asap window via Anthropic SDK returns 200", async () => {
      const script = `
import anthropic
client = anthropic.Anthropic(
    auth_token="${process.env.SAIL_API_KEY}",
    base_url="${baseUrl}",
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
assert len(response.content) > 0
assert response.stop_reason == "end_turn"
print(f"OK: {response.content[0].text[:50]}")
`;
      const { exitCode, stdout, stderr } = await runUvxPython(
        ["anthropic"],
        script,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK:");
    }, 120_000);

    test("x-api-key auth via Anthropic SDK api_key param", async () => {
      const script = `
import anthropic
client = anthropic.Anthropic(
    api_key="${process.env.SAIL_API_KEY}",
    base_url="${baseUrl}",
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
print(f"OK: {response.content[0].text[:50]}")
`;
      const { exitCode, stdout } = await runUvxPython(["anthropic"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK:");
    }, 120_000);
  });

  // ── OpenAI SDK smoke test via uvx ───────────────────────────────────────

  describe("OpenAI SDK smoke test (uvx)", () => {
    test("asap window via OpenAI SDK returns 200", async () => {
      const script = `
from openai import OpenAI
client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${process.env.SAIL_API_KEY}",
)
response = client.chat.completions.create(
    model="${TEST_MODEL}",
    messages=[{"role": "user", "content": "say hi"}],
    max_tokens=32,
)
assert response.choices[0].message.content is not None
print(f"OK: {response.choices[0].message.content[:50]}")
`;
      const { exitCode, stdout } = await runUvxPython(["openai"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK:");
    }, 120_000);
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

  // ── Slow batched Responses API tests (opt-in) ───────────────────────────

  describe.skipIf(!runSlow)(
    "batched Responses API (priority/standard/flex)",
    () => {
      test("priority Responses API returns 200", async () => {
        const { status, body } = await sendResponses("priority");
        expect(status).toBe(200);
        expect(body.id).toBeDefined();
        expect(body.output).toBeDefined();
      }, 300_000);

      test("standard Responses API returns 200", async () => {
        const { status, body } = await sendResponses("standard");
        expect(status).toBe(200);
        expect(body.id).toBeDefined();
      }, 300_000);

      test("flex Responses API returns 200", async () => {
        const { status, body } = await sendResponses("flex");
        expect(status).toBe(200);
        expect(body.id).toBeDefined();
      }, 600_000);
    },
  );

  // ── Slow batched Messages API tests (opt-in) ────────────────────────────

  describe.skipIf(!runSlow)(
    "batched Messages API (priority/standard/flex)",
    () => {
      test("flex Messages API returns 200 with Anthropic format", async () => {
        const { status, body } = await sendMessages("flex");
        expect(status).toBe(200);
        expect(body.type).toBe("message");
        expect(body.role).toBe("assistant");
        expect(body.content).toBeDefined();
        expect(body.stop_reason).toBe("end_turn");
      }, 600_000);

      test("flex Messages API creates dashboard job with apiType messages", async () => {
        // Send a flex messages request
        const { status } = await sendMessages("flex");
        expect(status).toBe(200);

        // Check dashboard for the job
        const dashboard = await fetchDashboardJobs();
        const messageJob = dashboard.jobs.find(
          (j: any) => j.apiType === "messages",
        );
        expect(messageJob).toBeDefined();
        expect(messageJob.completionWindow).toBe("flex");
        expect(messageJob.status).toBe("completed");
      }, 600_000);

      test("priority Messages API returns 200", async () => {
        const { status, body } = await sendMessages("priority");
        expect(status).toBe(200);
        expect(body.type).toBe("message");
        expect(body.content).toBeDefined();
      }, 300_000);
    },
  );

  // ── Slow dashboard tracking tests (opt-in) ──────────────────────────────

  describe.skipIf(!runSlow)("dashboard tracking for batched jobs", () => {
    test("chat completions batched job appears on dashboard with apiType", async () => {
      const { status } = await sendChatCompletion("flex");
      expect(status).toBe(200);

      const dashboard = await fetchDashboardJobs();
      const chatJob = dashboard.jobs.find(
        (j: any) => j.apiType === "chat-completions",
      );
      expect(chatJob).toBeDefined();
      expect(chatJob.completionWindow).toBe("flex");
      expect(chatJob.status).toBe("completed");
    }, 600_000);

    test("Responses API batched job appears on dashboard with apiType", async () => {
      const { status } = await sendResponses("flex");
      expect(status).toBe(200);

      const dashboard = await fetchDashboardJobs();
      const responsesJob = dashboard.jobs.find(
        (j: any) => j.apiType === "responses",
      );
      expect(responsesJob).toBeDefined();
      expect(responsesJob.completionWindow).toBe("flex");
      expect(responsesJob.status).toBe("completed");
    }, 600_000);
  });

  // ── Slow Anthropic SDK batching smoke test (opt-in) ─────────────────────

  describe.skipIf(!runSlow)(
    "Anthropic SDK batching smoke test (uvx, flex)",
    () => {
      test("flex window via Anthropic SDK creates dashboard job", async () => {
        const script = `
import anthropic
client = anthropic.Anthropic(
    auth_token="${process.env.SAIL_API_KEY}",
    base_url="${baseUrl}/flex",
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
assert response.stop_reason == "end_turn"
print(f"OK: {response.content[0].text[:50]}")
`;
        const { exitCode, stdout } = await runUvxPython(["anthropic"], script);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("OK:");

        // Verify dashboard shows a messages-type job
        const dashboard = await fetchDashboardJobs();
        const msgJob = dashboard.jobs.find(
          (j: any) => j.apiType === "messages",
        );
        expect(msgJob).toBeDefined();
        expect(msgJob.completionWindow).toBe("flex");
      }, 600_000);
    },
  );
});
