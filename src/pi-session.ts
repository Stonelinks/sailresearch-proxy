/**
 * Embedded pi SDK session helpers.
 *
 * Replaces the `pi` CLI subprocess with in-process SDK calls. Registers a
 * provider with its own model definition pointing at the local proxy —
 * so research and scraping always route through the proxy, and no
 * ~/.pi/agent/models.json entry is required.
 *
 * `runPiPrompt(prompt)` runs one research prompt on the first of
 * RESEARCH_MODELS (routed via RESEARCH_WINDOW), moving to the next model
 * when Sail reports the current one out of capacity or its reply is rejected.
 */
import { DEFAULT_PROVIDER } from "./constants.ts";
import { config } from "./config.ts";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { log } from "../shared/logger.ts";

// ─── Shared config ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a data extraction assistant. Return ONLY valid JSON. No markdown fences, no commentary.";

/** Sail's 503 when a model has no capacity, e.g. `model_capacity_unavailable`
 *  "This model is temporarily unavailable. Please retry with backoff." */
const CAPACITY_ERROR = /model_capacity_unavailable|temporarily unavailable/i;

let _modelRuntime: Promise<ModelRuntime> | undefined;

// Memoize the promise, not the value: research runs prompts concurrently and
// each caller must share one runtime.
function getModelRuntime(): Promise<ModelRuntime> {
  _modelRuntime ??= (async () => {
    const runtime = await ModelRuntime.create();

    // Base URL for the local proxy's OpenAI-compatible endpoint. The window
    // prefix (default "asap") routes research LLM calls through the proxy's
    // low-latency window instead of a cheaper scheduled one — pricier per
    // token, but research prompts are tiny and it turns minutes-long
    // scheduling waits into interactive-latency calls. Every research model
    // must support the configured window. Read here, not at import, so tests
    // can point config at a fake upstream.
    const baseUrl = `http://127.0.0.1:${config.server.port}/${config.research.window}/v1`;

    // Register the default provider with the research models pointing at the
    // local proxy. This works even when ~/.pi/agent/models.json has no such
    // entry (e.g. on a fresh deploy) because we include the model definition
    // directly in the provider config.
    //
    // The pi SDK requires apiKey or oauth when models are provided. When the
    // proxy requires an API key (PROXY_API_KEY is set), we pass it through so
    // internal SDK calls authenticate correctly. When no key is configured
    // (the default), we pass a dummy value to satisfy the SDK's validation —
    // the proxy skips auth when proxyApiKey is empty, so the dummy is ignored.
    const apiKey = config.proxyApiKey || "sail-proxy-internal";
    runtime.registerProvider(DEFAULT_PROVIDER, {
      baseUrl: baseUrl,
      apiKey,
      api: "openai-completions",
      models: config.research.models.map((id) => ({
        id,
        name: id,
        api: "openai-completions" as const,
        baseUrl: baseUrl,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 16384,
      })),
    });

    // A stored ~/.pi/agent/auth.json entry for this provider would otherwise
    // win over the apiKey above: the entrypoint's plain-string entry disables
    // the provider, and a valid one sends the Sail key instead of the proxy key.
    // A runtime key takes precedence and is never written to disk.
    await runtime.setRuntimeApiKey(DEFAULT_PROVIDER, apiKey);

    log.debug(
      `[pi-session] registered ${DEFAULT_PROVIDER} → ${baseUrl} with models ${config.research.models.join(", ")}`,
    );
    return runtime;
  })();
  return _modelRuntime;
}

function makeResourceLoader(systemPrompt = SYSTEM_PROMPT) {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Run one prompt and return the assistant's text. Throws when the final
 * assistant message ended with stopReason "error" (provider or config
 * failure) instead of returning "" for the caller to misreport.
 */
async function promptText(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  prompt: string,
): Promise<string> {
  let text = "";
  let lastAssistant: { stopReason?: string; errorMessage?: string } | undefined;
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    } else if (event.type === "message_end") {
      const msg = event.message;
      if (msg && msg.role === "assistant") {
        lastAssistant = msg;
        // Fallback: if no text_delta events were captured (e.g. non-streaming
        // response or single-chunk delivery), extract text from the final message.
        if (text.length === 0) {
          for (const part of msg.content ?? []) {
            if (part && (part as any).type === "text") {
              text += (part as any).text ?? "";
            }
          }
        }
      }
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }

  if (lastAssistant?.stopReason === "error") {
    throw new Error(`pi SDK error: ${lastAssistant.errorMessage ?? "unknown"}`);
  }
  return text;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a one-shot research prompt and return the raw text response. Tries
 * RESEARCH_MODELS in order, falling through to the next model on a capacity
 * error, or when `accept` is given and returns false for the reply (e.g. a
 * model that answered with a chat-template fragment instead of JSON). Any
 * other error is thrown as-is. When the last model's reply is rejected it is
 * returned anyway, for the caller to report. Each model gets pi's own retries
 * first (2 retries, 2s then 4s backoff).
 *
 * No extensions, no session persistence.
 */
export async function runPiPrompt(
  prompt: string,
  accept?: (text: string) => boolean,
): Promise<string> {
  const modelRuntime = await getModelRuntime();
  const modelIds = config.research.models;
  for (const [i, modelId] of modelIds.entries()) {
    const model = modelRuntime.getModel(DEFAULT_PROVIDER, modelId);
    if (!model) {
      throw new Error(
        `Model ${DEFAULT_PROVIDER}/${modelId} not found in pi model registry. ` +
          `This should not happen — it is registered at startup. Check pi-session.ts.`,
      );
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader: makeResourceLoader(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    });

    try {
      const text = await promptText(session, prompt);
      if (accept && !accept(text)) {
        log.warn(
          `[pi-session] ${modelId} reply rejected: ${text.slice(0, 500)}`,
        );
        if (modelIds[i + 1]) continue;
      }
      log.info(`[pi-session] research prompt ran on ${modelId}`);
      return text;
    } catch (err) {
      const next = modelIds[i + 1];
      if (!next || !CAPACITY_ERROR.test(String(err))) throw err;
      log.warn(
        `[pi-session] ${modelId} out of capacity, falling back to ${next}: ${err}`,
      );
    }
  }
  throw new Error("RESEARCH_MODELS is empty");
}
