import { config } from "../config.ts";
import { openAIError } from "../errors.ts";
import { handlePassthrough } from "../services/passthrough.ts";
import { handleBatching } from "../services/batching.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";

export async function handleChatCompletions(
  req: Request,
  poller: Poller,
): Promise<Response> {
  // Auth check
  if (config.proxyApiKey) {
    const auth = req.headers.get("authorization");
    const token = auth?.replace(/^Bearer\s+/i, "");
    if (token !== config.proxyApiKey) {
      return openAIError(401, "Invalid API key", "authentication_error");
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return openAIError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!body.model) {
    return openAIError(
      400,
      "model is required",
      "invalid_request_error",
      "model",
    );
  }

  // Determine completion window (header > body metadata > default)
  const completionWindow = (req.headers.get("x-completion-window") ??
    body.metadata?.completion_window ??
    config.defaults.completionWindow) as CompletionWindow;

  const wantsStream = body.stream === true;

  if (completionWindow === "asap") {
    return handlePassthrough(body, completionWindow, wantsStream);
  }

  return handleBatching(body, completionWindow, wantsStream, poller);
}
