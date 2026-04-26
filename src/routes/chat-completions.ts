import { config } from "../config.ts";
import { log } from "../logger.ts";
import { openAIError } from "../errors.ts";
import { handlePassthrough } from "../services/passthrough.ts";
import { handleBatching } from "../services/batching.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";

export async function handleChatCompletions(
  req: Request,
  poller: Poller,
): Promise<Response> {
  const headerWindow = req.headers.get("x-completion-window");
  log.debug(
    `[req] hasAuth=${req.headers.get("authorization") != null} headerWindow=${headerWindow ?? "<none>"}`,
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

  // Determine completion window (header > body metadata > default)
  const windowSource = headerWindow
    ? "header"
    : body.metadata?.completion_window
      ? "metadata"
      : "default";
  const completionWindow = (headerWindow ??
    body.metadata?.completion_window ??
    config.defaults.completionWindow) as CompletionWindow;
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
