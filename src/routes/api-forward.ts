/**
 * The three inference routes (chat-completions, messages, responses) share
 * one shape: parse/auth/window-resolve via parseRequest, run a cheap
 * API-surface-specific validation for friendlier client errors, then hand
 * off to the thin forwarder. A factory replaces the three former route
 * files that each carried a passthrough-vs-batching fork.
 */
import { log } from "../../shared/logger.ts";
import { openAIError } from "../errors.ts";
import { parseRequest } from "./parse-request.ts";
import { forwardToSail } from "../services/forward.ts";
import { resolvePresetModel } from "../services/preset-resolver.ts";
import type { ErrorFormat, SailPath } from "../services/forward.ts";
import type { CompletionWindow } from "../types.ts";

interface ForwardRouteOpts {
  /** Used in log prefixes — e.g. "chat-completions". */
  routeName: string;
  /** Sail endpoint path the request forwards to. */
  path: SailPath;
  /** Shape of the 502 body when the upstream fetch itself fails. */
  errorFormat: ErrorFormat;
  /** Optional body validation; returns an error Response to short-circuit. */
  validate?: (body: any) => Response | null;
}

export function makeForwardHandler(opts: ForwardRouteOpts) {
  return async (
    req: Request,
    urlPrefix: CompletionWindow | null = null,
  ): Promise<Response> => {
    const parsed = await parseRequest(req, {
      routeName: opts.routeName,
      urlPrefix,
    });
    if ("error" in parsed) return parsed.error;
    const { body, completionWindow, windowSource } = parsed.ok;

    const invalid = opts.validate?.(body);
    if (invalid) return invalid;

    log.debug(
      `[${opts.routeName}] model=${body.model} window=${completionWindow} source=${windowSource} stream=${body.stream === true}`,
    );

    return forwardToSail({
      path: opts.path,
      body: await resolvePresetModel(body),
      window: completionWindow,
      clientSignal: req.signal,
      errorFormat: opts.errorFormat,
      logPrefix: opts.routeName,
    });
  };
}

export const handleChatCompletions = makeForwardHandler({
  routeName: "chat-completions",
  path: "/chat/completions",
  errorFormat: "openai",
});

export const handleMessages = makeForwardHandler({
  routeName: "messages",
  path: "/messages",
  errorFormat: "anthropic",
  validate(body) {
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
    return null;
  },
});

export const handleResponses = makeForwardHandler({
  routeName: "responses",
  path: "/responses",
  errorFormat: "openai",
  validate(body) {
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      return openAIError(
        400,
        "input is required and must be a non-empty array or string",
        "invalid_request_error",
        "input",
      );
    }
    return null;
  },
});
