import { sail } from "../sail-client.ts";
import { log } from "../logger.ts";
import { openAIError } from "../errors.ts";
import { resolveCompletionWindow } from "../completion-window.ts";
import { config } from "../config.ts";
import type { CompletionWindow } from "../types.ts";

/**
 * Handle POST /v1/messages — Anthropic Messages API.
 *
 * Sail natively supports /v1/messages, so we forward the request directly,
 * injecting the completion_window into metadata and stripping fields that
 * Sail doesn't support.
 */
export async function handleMessages(
  req: Request,
  urlPrefix: CompletionWindow | null = null,
): Promise<Response> {
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
    log.debug("[messages] invalid JSON body");
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

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return openAIError(
      400,
      "messages is required and must be a non-empty array",
      "invalid_request_error",
      "messages",
    );
  }

  // Determine completion window
  const headerWindow = req.headers.get("x-completion-window");
  const { window: completionWindow } = resolveCompletionWindow(
    urlPrefix,
    headerWindow,
    body.metadata,
    config.defaults.completionWindow,
  );
  log.debug(
    `[messages] model=${body.model} window=${completionWindow} msgs=${body.messages.length}`,
  );

  // Build the request for Sail's /v1/messages endpoint
  const sailBody: any = {
    ...body,
    metadata: {
      ...body.metadata,
      completion_window: completionWindow,
    },
  };

  // Strip stream — Sail doesn't support streaming on Messages API
  delete sailBody.stream;

  // Strip fields Sail doesn't support on Messages API
  // (per the API matrix: system, thinking, tools, tool_choice,
  //  stop_sequences, top_k, service_tier, inference_geo)
  delete sailBody.system;
  delete sailBody.thinking;
  delete sailBody.tools;
  delete sailBody.tool_choice;
  delete sailBody.stop_sequences;
  delete sailBody.top_k;
  delete sailBody.service_tier;
  delete sailBody.inference_geo;

  const { status, data } = await sail.createMessage(sailBody);
  log.debug(`[messages] sail status=${status}`);

  if (status !== 200) {
    // Return Sail's error in Anthropic-compatible format if it's already shaped
    // that way, otherwise wrap it
    if (data?.error) {
      return Response.json(data, { status });
    }
    return Response.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: data?.message || `Sail API error: ${status}`,
        },
      },
      { status: status >= 500 ? 502 : status },
    );
  }

  return Response.json(data);
}
