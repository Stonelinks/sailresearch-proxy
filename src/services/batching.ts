import { prisma } from "../db.ts";
import { sail } from "../sail-client.ts";
import { config, getTimeoutMs } from "../config.ts";
import { log } from "../logger.ts";
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
  log.debug(
    `[batch] transformed request keys=${Object.keys(sailBody).join(",")}`,
  );

  // Submit to Sail
  const { status, data } = await sail.createResponse(sailBody);
  log.debug(
    `[batch] sail submit status=${status} id=${data?.id} sailStatus=${data?.status}`,
  );

  if (status !== 200 && status !== 202) {
    return mapSailError(status, data);
  }

  // If Sail returned a completed response synchronously (unlikely but possible)
  if (data.status === "completed") {
    log.info(`[batch] sail returned completed synchronously id=${data.id}`);
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
  log.debug(
    `[batch] persisting job id=${sailResponseId} model=${body.model} window=${completionWindow}`,
  );
  await prisma.pendingJob.create({
    data: {
      sailResponseId,
      status: data.status ?? "pending",
      requestBody: JSON.stringify(body),
      model: body.model ?? config.defaults.model,
      completionWindow,
    },
  });

  // Register in-memory waiter and await result with window-specific timeout
  const timeoutMs = getTimeoutMs(completionWindow);
  log.debug(
    `[batch] waiter registered id=${sailResponseId} window=${completionWindow} timeoutMs=${timeoutMs}`,
  );
  const resultPromise = poller
    .registerWaiter(sailResponseId)
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  const timeoutPromise = new Promise<{ ok: false; error: "timeout" }>(
    (resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        timeoutMs,
      ),
  );

  const outcome = await Promise.race([resultPromise, timeoutPromise]);
  log.debug(`[batch] outcome id=${sailResponseId} ok=${outcome.ok}`);

  if (!outcome.ok) {
    poller.unregisterWaiter(sailResponseId);
    if (outcome.error === "timeout") {
      log.warn(
        `[batch] timeout id=${sailResponseId} window=${completionWindow} ms=${timeoutMs}`,
      );
      return openAIError(
        504,
        `Request timed out after ${timeoutMs}ms (window: ${completionWindow}). Job ${sailResponseId} is still processing on Sail.`,
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

  log.debug(`[batch] mapping responses → chat completion id=${sailResponseId}`);
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
