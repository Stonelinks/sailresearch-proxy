/**
 * Embedded pi SDK session helpers.
 *
 * Replaces the `pi` CLI subprocess with in-process SDK calls. Registers a
 * provider with its own model definition pointing at the local proxy —
 * so research and scraping always route through the proxy, and no
 * ~/.pi/agent/models.json entry is required.
 *
 * Two modes:
 *   - `runPiPrompt(prompt)` — one-shot call using the default model
 *     (sail-standard / zai-org/GLM-5.1-FP8)
 *   - `runPiChat(provider, modelId, prompt)` — one-shot call targeting a
 *     specific provider/model (used by smoke tests)
 */
import { DEFAULT_PROVIDER } from "./constants.ts";
import { config } from "./config.ts";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { log } from "../shared/logger.ts";

// ─── Shared config ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a data extraction assistant. Return ONLY valid JSON. No markdown fences, no commentary.";

const DEFAULT_MODEL_ID = config.defaults.model;

/**
 * Base URL for the local proxy's OpenAI-compatible endpoint.
 * The embedded pi SDK uses this as the provider's baseUrl.
 */
const LOCAL_PROXY_BASE_URL = `http://127.0.0.1:${config.server.port}/v1`;

let _authStorage: ReturnType<typeof AuthStorage.create> | undefined;
let _modelRegistry: ReturnType<typeof ModelRegistry.create> | undefined;

function getAuthStorage() {
  if (!_authStorage) {
    _authStorage = AuthStorage.create();
  }
  return _authStorage;
}

function getModelRegistry() {
  if (!_modelRegistry) {
    _modelRegistry = ModelRegistry.create(getAuthStorage());

    // Register the sail-standard provider with the default model pointing at
    // the local proxy. This works even when ~/.pi/agent/models.json has no
    // sail-standard entry (e.g. on a fresh deploy) because we include the
    // model definition directly in the provider config.
    //
    // The pi SDK requires apiKey or oauth when models are provided. When the
    // proxy requires an API key (PROXY_API_KEY is set), we pass it through so
    // internal SDK calls authenticate correctly. When no key is configured
    // (the default), we pass a dummy value to satisfy the SDK's validation —
    // the proxy skips auth when proxyApiKey is empty, so the dummy is ignored.
    const apiKey = config.proxyApiKey || "sail-proxy-internal";
    _modelRegistry.registerProvider(DEFAULT_PROVIDER, {
      baseUrl: LOCAL_PROXY_BASE_URL,
      apiKey,
      api: "openai-completions",
      models: [
        {
          id: DEFAULT_MODEL_ID,
          name: DEFAULT_MODEL_ID,
          api: "openai-completions",
          baseUrl: LOCAL_PROXY_BASE_URL,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 16384,
        },
      ],
    });

    log.debug(
      `[pi-session] registered ${DEFAULT_PROVIDER} → ${LOCAL_PROXY_BASE_URL} with model ${DEFAULT_MODEL_ID}`,
    );
  }
  return _modelRegistry;
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
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a one-shot prompt to the default pi model and return the raw text
 * response. Uses `sail-standard/zai-org/GLM-5.1-FP8` by default.
 *
 * No tools, no extensions, no session persistence — just a single LLM call.
 */
export async function runPiPrompt(prompt: string): Promise<string> {
  const authStorage = getAuthStorage();
  const modelRegistry = getModelRegistry();
  const model = modelRegistry.find(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);

  if (!model) {
    throw new Error(
      `Model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} not found in pi model registry. ` +
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
    authStorage,
    modelRegistry,
    resourceLoader: makeResourceLoader(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager,
  });

  let text = "";
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    } else if (event.type === "message_end") {
      // Fallback: if no text_delta events were captured (e.g. non-streaming
      // response or single-chunk delivery), extract text from the final message.
      if (text.length === 0) {
        const msg = event.message;
        if (msg && msg.role === "assistant") {
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

  return text;
}

/**
 * Send a one-shot prompt to a specific provider/model and return the raw text
 * response. Used by smoke tests that need to hit a particular provider+model.
 *
 * @param provider  Provider name (e.g. "sail-standard", "sail-flex")
 * @param modelId   Model ID within that provider (e.g. "zai-org/GLM-5.1-FP8")
 * @param prompt    The prompt text
 */
export async function runPiChat(
  provider: string,
  modelId: string,
  prompt: string,
): Promise<string> {
  const authStorage = getAuthStorage();
  const modelRegistry = getModelRegistry();
  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(
      `Model ${provider}/${modelId} not found in pi model registry. ` +
        `Ensure the pi model registry has a "${provider}" provider with model "${modelId}".`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader: makeResourceLoader(
      "You are a helpful assistant. Be concise.",
    ),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager,
  });

  let text = "";
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    } else if (event.type === "message_end") {
      if (text.length === 0) {
        const msg = event.message;
        if (msg && msg.role === "assistant") {
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

  return text;
}
