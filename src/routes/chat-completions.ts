import { config } from "../config.ts";
import { log } from "../logger.ts";
import { openAIError } from "../errors.ts";
import { handlePassthrough } from "../services/passthrough.ts";
import { handleBatching } from "../services/batching.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";
import { resolveCompletionWindow } from "../completion-window.ts";

export async function handleChatCompletions(
  req: Request,
  poller: Poller,
  urlPrefix: CompletionWindow | null = null,
): Promise<Response> {
  const headerWindow = req.headers.get("x-completion-window");
  log.debug(
    `[req] hasAuth=${req.headers.get("authorization") != null} headerWindow=${headerWindow ?? "<none>"} urlPrefix=${urlPrefix ?? "<none>"}`,
  );

  // Auth check
  if (config.proxyApiKey) {
    const auth = req.headers.get("authorization");
    const token = auth?.replace(/^Bearer\s+/i, "");
    if (token !== config.proxyApiKey) {
      log.warn("[auth] rejected request: invalid api key");
      return openAIError(401, "Invalid API key", "authentication_error");
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    log.debug("[req] invalid JSON body");
    return openAIError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!body.model) {
    log.debug("[req] missing model field");
    return openAIError(
      400,
      "model is required",
      "invalid_request_error",
      "model",
    );
  }

  const wantsStream = body.stream === true;
  log.debug(
    `[req] parsed body model=${body.model} stream=${wantsStream} msgs=${body.messages?.length ?? 0}`,
  );

  // Determine completion window (prefix > header > body metadata > default)
  const { window: completionWindow, source: windowSource } =
    resolveCompletionWindow(
      urlPrefix,
      headerWindow,
      body.metadata,
      config.defaults.completionWindow,
    );
  log.debug(
    `[req] window=${completionWindow} source=${windowSource}`,
  );

  if (completionWindow === "asap") {
    log.debug("[req] dispatching to passthrough");
    return handlePassthrough(body, completionWindow, wantsStream);
  }

  log.debug("[req] dispatching to batching");
  return handleBatching(body, completionWindow, wantsStream, poller);
}
