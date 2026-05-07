/**
 * Embedded pi SDK session helpers.
 *
 * Replaces the `pi` CLI subprocess with in-process SDK calls. Registers a
 * provider that always points at the local proxy, regardless of what
 * `~/.pi/agent/models.json` says — so research and scraping always go
 * through the proxy.
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
 * The embedded pi SDK will hit this instead of whatever is in
 * ~/.pi/agent/models.json.
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

    // Override the sail-standard provider to always point at the local proxy,
    // regardless of what ~/.pi/agent/models.json says. This ensures that
    // embedded pi calls (research, scraping) always route through the proxy.
    _modelRegistry.registerProvider(DEFAULT_PROVIDER, {
      baseUrl: LOCAL_PROXY_BASE_URL,
      // No apiKey — the proxy doesn't require one for internal calls.
      // The pi SDK will send a request with no Authorization header,
      // and the proxy's parseRequest will accept it (proxyApiKey defaults
      // to "" when PROXY_API_KEY is unset).
      api: "openai-completions",
    });

    log.debug(
      `[pi-session] registered ${DEFAULT_PROVIDER} → ${LOCAL_PROXY_BASE_URL}`,
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
        `Ensure ~/.pi/agent/models.json has a "${DEFAULT_PROVIDER}" provider with this model.`,
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
 * @param provider  Provider name from models.json (e.g. "sail-standard", "sail-flex")
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
        `Ensure ~/.pi/agent/models.json has a "${provider}" provider with this model.`,
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
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }

  return text;
}
