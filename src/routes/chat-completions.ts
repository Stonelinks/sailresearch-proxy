import { log } from "../../shared/logger.ts";
import { handlePassthrough } from "../services/passthrough.ts";
import { handleBatching } from "../services/batching.ts";
import { parseRequest } from "./parse-request.ts";
import type { Poller } from "../services/poller.ts";
import type { CompletionWindow } from "../types.ts";

export async function handleChatCompletions(
  req: Request,
  poller: Poller,
  urlPrefix: CompletionWindow | null = null,
): Promise<Response> {
  const parsed = await parseRequest(req, {
    routeName: "chat-completions",
    urlPrefix,
  });
  if ("error" in parsed) return parsed.error;
  const { body, completionWindow, windowSource } = parsed.ok;

  const wantsStream = body.stream === true;
  log.debug(
    `[chat-completions] model=${body.model} stream=${wantsStream} msgs=${body.messages?.length ?? 0} window=${completionWindow} source=${windowSource}`,
  );

  if (completionWindow === "asap") {
    return handlePassthrough(body, completionWindow, wantsStream);
  }
  return handleBatching(body, completionWindow, wantsStream, poller);
}
