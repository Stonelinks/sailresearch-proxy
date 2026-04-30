import { prisma } from "../db.ts";
import { log } from "../logger.ts";
import { chatToResponsesAPI } from "../transforms/request.ts";
import { responsesToChatCompletion } from "../transforms/response.ts";
import { streamResponse } from "./stream.ts";
import { submitAndWait, formatOpenAIError } from "./batch-submit.ts";
import type { Poller } from "./poller.ts";
import type { CompletionWindow } from "../types.ts";
import type { PrismaClient } from "@prisma/client";

export async function handleBatching(
  body: any,
  completionWindow: CompletionWindow,
  wantsStream: boolean,
  poller: Poller,
  apiType: "chat-completions" | "messages" | "responses" = "chat-completions",
  db: PrismaClient = prisma,
): Promise<Response> {
  // Transform OpenAI chat completion request → Sail Responses API
  const sailBody = chatToResponsesAPI(body, completionWindow);
  log.debug(
    `[batch] transformed request keys=${Object.keys(sailBody).join(",")}`,
  );

  const result = await submitAndWait({
    sailBody,
    completionWindow,
    apiType,
    originalRequestBody: body,
    model: body.model ?? "unknown",
    poller,
    db,
    logPrefix: "batch",
  });

  if (!result.ok) {
    return formatOpenAIError(result.error);
  }

  const completion = responsesToChatCompletion(result.data);

  if (wantsStream) {
    return new Response(streamResponse(completion), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return Response.json(completion);
}
