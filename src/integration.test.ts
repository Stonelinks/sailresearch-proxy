/**
 * Integration test: starts a real proxy server with a temp DB on a random
 * port, then sends requests through each completion window and verifies
 * the response is not an error.
 *
 * By default (`bun test`), only fast asap tests run. Set
 * SAIL_SLOW_INTEGRATION=1 to also test the batched windows
 * (priority/standard/flex), which Sail serves synchronously but may take
 * minutes to schedule.
 *
 * Which windows a model supports varies over time, so the slow tests
 * discover a supporting model per window from Sail's structured
 * "completion_window not available" error, and skip windows no model
 * currently offers.
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

// `bin/test` defaults SAIL_API_KEY to "test" when unset, so a plain truthy
// check would run the live suite against Sail with a placeholder key. Treat
// "test" as "no key" so the suite cleanly skips on machines without secrets.
const apiKey = process.env.SAIL_API_KEY;
const hasApiKey = !!apiKey && apiKey !== "test";
const runSlow = process.env.SAIL_SLOW_INTEGRATION === "1";

// Small, fast model for asap tests. Batched-window tests pick their model
// dynamically (see firstSupportedResult).
const TEST_MODEL = "openai/gpt-oss-120b";
const IMAGE_MODEL = "moonshotai/Kimi-K2.6";

// ── Helpers ─────────────────────────────────────────────────────────────────

function windowUrl(window: CompletionWindow, path: string): string {
  return window === "standard"
    ? `${baseUrl}${path}`
    : `${baseUrl}/${window}${path}`;
}

/**
 * Send a chat completions request via fetch. Includes the same fields pi
 * sends (store:false etc.) to verify the forwarder normalizes them.
 */
async function sendChatCompletion(
  window: CompletionWindow,
  model = TEST_MODEL,
): Promise<{ status: number; body: any }> {
  const res = await fetch(windowUrl(window, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "say hi" }],
      max_tokens: 32,
      // Pi sends these — verify the forwarder handles them
      store: false,
      prompt_cache_key: "test-session",
      stream: false,
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/** Send a Responses API request via fetch. */
async function sendResponses(
  window: CompletionWindow,
  model = TEST_MODEL,
): Promise<{ status: number; body: any }> {
  const res = await fetch(windowUrl(window, "/v1/responses"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model,
      input: "say hi",
      max_output_tokens: 32,
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/** Send an Anthropic Messages API request via fetch. */
async function sendMessages(
  window: CompletionWindow,
  model = TEST_MODEL,
): Promise<{ status: number; body: any }> {
  const res = await fetch(windowUrl(window, "/v1/messages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

/** True when the body is Sail's "window not available for model" error. */
function isWindowUnsupported(body: any): boolean {
  const msg = body?.error?.message;
  return typeof msg === "string" && msg.includes("not available for model");
}

let cachedModelIds: string[] | null = null;
async function listModelIds(): Promise<string[]> {
  if (!cachedModelIds) {
    const res = await fetch(`${baseUrl}/v1/models`);
    const body: any = await res.json();
    cachedModelIds = (body.data ?? []).map((m: any) => m.id as string);
  }
  return cachedModelIds!;
}

/**
 * Run `send` against models until one supports the window. Returns null when
 * no model currently offers the window (the caller should skip). Unsupported
 * probes fail fast with a structured 400, so at most one real inference runs.
 */
async function firstSupportedResult(
  send: (model: string) => Promise<{ status: number; body: any }>,
): Promise<{ status: number; body: any; model: string } | null> {
  for (const model of await listModelIds()) {
    const r = await send(model);
    if (r.status === 400 && isWindowUnsupported(r.body)) continue;
    return { ...r, model };
  }
  return null;
}

/**
 * Run pi headlessly against a specific provider/base URL configuration.
 * Uses PI_CODING_AGENT_DIR to point pi at a temp directory with a custom
 * models.json that routes to our test proxy.
 */
async function runPiSmoke(
  window: CompletionWindow,
): Promise<{ exitCode: number; output: string }> {
  const providerBaseUrl =
    window === "standard" ? `${baseUrl}/v1` : `${baseUrl}/${window}/v1`;

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
    process.env.DEFAULT_COMPLETION_WINDOW = "standard";
    process.env.PROXY_API_KEY = "";

    // Apply committed migrations against the temp DB (same path as prod
    // startup; works from an empty file).
    const migrateResult = Bun.spawnSync(
      ["bunx", "prisma", "migrate", "deploy"],
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
        `prisma migrate deploy failed: ${migrateResult.stderr.toString()}`,
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
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Fast asap tests (always run) ─────────────────────────────────────────

  describe("asap (forwarded)", () => {
    test("returns 200, not 400 store=false", async () => {
      const { status, body } = await sendChatCompletion("asap");
      expect(status).toBe(200);
      expect(
        body.choices?.[0]?.message?.content ??
          body.choices?.[0]?.message?.reasoning_content,
      ).toBeDefined();
    }, 60_000);

    test("does not forward store=false to Sail", async () => {
      const { status, body } = await sendChatCompletion("asap");
      expect(status).not.toBe(400);
      const errMsg =
        typeof body?.error?.message === "string" ? body.error.message : "";
      expect(errMsg).not.toContain("store=false");
    }, 60_000);
  });

  // ── Local handlers (no Sail call, but gated to share the live-suite server) ─

  describe("local handlers", () => {
    test("GET /health returns 200 with body 'ok'", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });

    test("GET /v1/models returns OpenAI list shape", async () => {
      const res = await fetch(`${baseUrl}/v1/models`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      for (const m of body.data) expect(m.object).toBe("model");
    }, 30_000);

    test("unknown /v1/ route returns 404", async () => {
      const res = await fetch(`${baseUrl}/v1/nonexistent`);
      expect(res.status).toBe(404);
    });

    test("GET /api/version returns version and commit", async () => {
      const res = await fetch(`${baseUrl}/api/version`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
      expect(typeof body.commit).toBe("string");
    });
  });

  // ── asap input-format compatibility ─────────────────────────────────────

  describe("asap input compatibility", () => {
    test("max_tokens field works (Sail accepts it natively now)", async () => {
      const res = await fetch(`${baseUrl}/asap/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say hi." }],
          max_tokens: 10,
        }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.choices?.[0]?.message).toBeDefined();
    }, 60_000);

    test("X-Completion-Window header (no URL prefix) is honored", async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Completion-Window": "asap",
          Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Say yes." }],
          max_completion_tokens: 5,
        }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.choices?.[0]?.message).toBeDefined();
    }, 60_000);
  });

  // ── asap streaming SSE format ───────────────────────────────────────────

  describe("asap streaming", () => {
    test("SSE body contains expected chunk markers", async () => {
      const res = await fetch(`${baseUrl}/asap/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "Count 1 to 3." }],
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 20,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("chat.completion.chunk");
      expect(text).toContain('"role":"assistant"');
      expect(text).toContain("[DONE]");
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

  // ── Image input tests (always run, asap) ─────────────────────────────────

  describe("image input (asap)", () => {
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

  // ── Responses API tests (always run, asap) ───────────────────────────────

  describe("Responses API (asap)", () => {
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
    base_url="${baseUrl}/asap",
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
assert len(response.content) > 0
assert response.stop_reason == "end_turn"
print("OK")
`;
      const { exitCode, stdout } = await runUvxPython(["anthropic"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK");
    }, 120_000);

    test("x-api-key auth via Anthropic SDK api_key param", async () => {
      const script = `
import anthropic
client = anthropic.Anthropic(
    api_key="${process.env.SAIL_API_KEY}",
    base_url="${baseUrl}/asap",
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
print("OK")
`;
      const { exitCode, stdout } = await runUvxPython(["anthropic"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK");
    }, 120_000);
  });

  // ── OpenAI SDK smoke test via uvx ───────────────────────────────────────

  describe("OpenAI SDK smoke test (uvx)", () => {
    test("asap window via OpenAI SDK returns 200", async () => {
      const script = `
from openai import OpenAI
client = OpenAI(
    base_url="${baseUrl}/asap/v1",
    api_key="${process.env.SAIL_API_KEY}",
)
response = client.chat.completions.create(
    model="${TEST_MODEL}",
    messages=[{"role": "user", "content": "say hi"}],
    max_tokens=32,
)
assert response.choices[0].message is not None
print("OK")
`;
      const { exitCode, stdout } = await runUvxPython(["openai"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK");
    }, 120_000);

    test("asap streaming via OpenAI SDK yields chunks", async () => {
      const script = `
from openai import OpenAI
client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${process.env.SAIL_API_KEY}",
)
stream = client.chat.completions.create(
    model="${TEST_MODEL}",
    messages=[{"role": "user", "content": "Say hello."}],
    max_tokens=128,
    stream=True,
    extra_body={"metadata": {"completion_window": "asap"}},
)
chunks = [c for c in stream if c.choices and c.choices[0].delta]
assert len(chunks) > 0, "no chunks received"
print(f"OK: {len(chunks)} chunks")
`;
      const { exitCode, stdout } = await runUvxPython(["openai"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK:");
    }, 120_000);
  });

  // ── Slow batched-window tests (opt-in) ──────────────────────────────────
  //
  // Sail now serves these synchronously; each test discovers a model that
  // supports the window and skips (with a log line) when none does.

  const SLOW_WINDOWS: CompletionWindow[] = ["priority", "standard", "flex"];

  describe.skipIf(!runSlow)("batched windows (chat completions)", () => {
    for (const window of SLOW_WINDOWS) {
      test(`${window} window returns 200 for some model`, async () => {
        const r = await firstSupportedResult((m) =>
          sendChatCompletion(window, m),
        );
        if (!r) {
          console.warn(`[slow] no model supports window=${window}; skipped`);
          return;
        }
        expect(r.status).toBe(200);
        expect(r.body.choices?.[0]?.message).toBeDefined();
      }, 600_000);
    }

    test("standard streaming SSE body contains chunk markers", async () => {
      const r = await firstSupportedResult(async (model) => {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.SAIL_API_KEY || ""}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "user", content: "Capital of France? One word." },
            ],
            metadata: { completion_window: "standard" },
            stream: true,
            max_tokens: 10,
          }),
        });
        if (res.status !== 200) {
          return { status: res.status, body: await res.json() };
        }
        return { status: res.status, body: await res.text() };
      });
      if (!r) {
        console.warn("[slow] no model supports window=standard; skipped");
        return;
      }
      expect(r.status).toBe(200);
      expect(r.body).toContain("chat.completion.chunk");
      expect(r.body).toContain("[DONE]");
    }, 600_000);
  });

  describe.skipIf(!runSlow)("batched windows (Responses API)", () => {
    for (const window of SLOW_WINDOWS) {
      test(`${window} Responses API returns 200 for some model`, async () => {
        const r = await firstSupportedResult((m) => sendResponses(window, m));
        if (!r) {
          console.warn(`[slow] no model supports window=${window}; skipped`);
          return;
        }
        expect(r.status).toBe(200);
        expect(r.body.id).toBeDefined();
        expect(r.body.output).toBeDefined();
      }, 600_000);
    }
  });

  describe.skipIf(!runSlow)("batched windows (Messages API)", () => {
    for (const window of SLOW_WINDOWS) {
      test(`${window} Messages API returns 200 with Anthropic format`, async () => {
        const r = await firstSupportedResult((m) => sendMessages(window, m));
        if (!r) {
          console.warn(`[slow] no model supports window=${window}; skipped`);
          return;
        }
        expect(r.status).toBe(200);
        expect(r.body.type).toBe("message");
        expect(r.body.role).toBe("assistant");
        expect(r.body.content).toBeDefined();
      }, 600_000);
    }
  });

  // ── Slow SDK batched smoke tests (opt-in) ───────────────────────────────

  describe.skipIf(!runSlow)("OpenAI SDK batched (uvx, priority)", () => {
    test("priority window via OpenAI SDK returns 200", async () => {
      const script = `
from openai import OpenAI
client = OpenAI(
    base_url="${baseUrl}/priority/v1",
    api_key="${process.env.SAIL_API_KEY}",
    timeout=300,
)
r = client.chat.completions.create(
    model="${TEST_MODEL}",
    messages=[{"role": "user", "content": "What is 10/2? Just the number."}],
    max_completion_tokens=64,
)
assert r.choices[0].message is not None
assert r.choices[0].finish_reason == "stop"
print("OK")
`;
      const { exitCode, stdout } = await runUvxPython(["openai"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK");
    }, 300_000);
  });

  describe.skipIf(!runSlow)("Anthropic SDK batched (uvx, priority)", () => {
    test("priority window via Anthropic SDK prefix URL returns 200", async () => {
      const script = `
import anthropic
client = anthropic.Anthropic(
    auth_token="${process.env.SAIL_API_KEY}",
    base_url="${baseUrl}/priority",
    timeout=300,
)
response = client.messages.create(
    model="${TEST_MODEL}",
    max_tokens=32,
    messages=[{"role": "user", "content": "say hi"}],
)
assert response.content is not None
print("OK")
`;
      const { exitCode, stdout } = await runUvxPython(["anthropic"], script);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK");
    }, 300_000);
  });
});
