import { prisma } from "../db.ts";
import { sail } from "../sail-client.ts";
import { config } from "../config.ts";
import { mapSailError, openAIError } from "../errors.ts";
import { chatToResponsesAPI } from "../transforms/request.ts";
import { responsesToChatCompletion } from "../transforms/response.ts";
import { streamResponse } from "./stream.ts";
import type { Poller } from "./poller.ts";
import type { CompletionWindow } from "../types.ts";

export async function handleBatching(
  body: any,
  completionWindow: CompletionWindow,
  wantsStream: boolean,
  poller: Poller,
): Promise<Response> {
  // Transform OpenAI chat completion request → Sail Responses API
  const sailBody = chatToResponsesAPI(body, completionWindow);

  // Submit to Sail
  const { status, data } = await sail.createResponse(sailBody);

  if (status !== 200 && status !== 202) {
    return mapSailError(status, data);
  }

  // If Sail returned a completed response synchronously (unlikely but possible)
  if (data.status === "completed") {
    const completion = responsesToChatCompletion(data);
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

  const sailResponseId = data.id;

  // Persist to DB
  await prisma.pendingJob.create({
    data: {
      sailResponseId,
      status: data.status ?? "pending",
      requestBody: JSON.stringify(body),
      model: body.model ?? config.defaults.model,
      completionWindow,
    },
  });

  // Register in-memory waiter and await result with timeout
  const resultPromise = poller
    .registerWaiter(sailResponseId)
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  const timeoutPromise = new Promise<{ ok: false; error: "timeout" }>(
    (resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        config.polling.maxDurationMs,
      ),
  );

  const outcome = await Promise.race([resultPromise, timeoutPromise]);

  if (!outcome.ok) {
    poller.unregisterWaiter(sailResponseId);
    if (outcome.error === "timeout") {
      return openAIError(
        504,
        `Request timed out after ${config.polling.maxDurationMs}ms. Job ${sailResponseId} is still processing on Sail.`,
        "timeout_error",
      );
    }
    // Sail returned a failed/cancelled status
    const errData = outcome.error;
    return openAIError(
      502,
      errData?.error?.message || `Sail request ${sailResponseId} failed`,
      "upstream_error",
    );
  }

  const completion = responsesToChatCompletion(outcome.result);

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
