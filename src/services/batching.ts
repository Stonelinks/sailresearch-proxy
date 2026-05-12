import { prisma } from "../db.ts";
import { log } from "../../shared/logger.ts";
import { chatToResponsesAPI } from "../transforms/request.ts";
import { responsesToChatCompletion } from "../transforms/response.ts";
import { streamResponse } from "./stream.ts";
import { SSE_HEADERS } from "../constants.ts";
import { submitAndWait, formatOpenAIError } from "./batch-submit.ts";
import { heartbeatStream } from "./heartbeat-stream.ts";
import type { BatchResult } from "./batch-submit.ts";
import type { Poller } from "./poller.ts";
import type { CompletionWindow } from "../types.ts";
import type { PrismaClient } from "@prisma/client";

const encoder = new TextEncoder();

/**
 * Create an SSE stream that sends heartbeats while waiting for the batch
 * result, then emits the chat-completion SSE chunks when it arrives.
 */
function streamBatchedChatCompletion(
  resultPromise: Promise<BatchResult>,
): ReadableStream<Uint8Array> {
  const { stream: heartbeatReadable, result } = heartbeatStream(resultPromise);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Pipe heartbeats into the controller
      const reader = heartbeatReadable.getReader();

      // Read heartbeats until the result settles
      const heartbeatDone = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch {
          // Heartbeat stream cancelled or errored — stop reading
        }
      })();

      // Wait for the batch result
      const batchResult = await result;

      // Close the heartbeat reader so the heartbeat interval stops
      reader.cancel();
      await heartbeatDone;

      if (!batchResult.ok) {
        // Emit an SSE error event, then close
        const errorData = {
          error: {
            type: batchResult.error.type,
            message: batchResult.error.message,
          },
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      // Emit the full chat-completion SSE sequence
      const completion = responsesToChatCompletion(batchResult.data);
      const chunks = streamResponse(completion);
      const chunkReader = chunks.getReader();

      try {
        while (true) {
          const { done, value } = await chunkReader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        chunkReader.cancel();
      }

      controller.close();
    },
    cancel() {
      // Client disconnected — heartbeat stream cleanup handled by its own cancel
    },
  });
}

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

  const resultPromise = submitAndWait({
    sailBody,
    completionWindow,
    apiType,
    originalRequestBody: body,
    model: body.model ?? "unknown",
    poller,
    db,
    logPrefix: "batch",
  });

  if (wantsStream) {
    // Stream mode: start SSE immediately with heartbeats during wait,
    // then emit the chat-completion chunks when the result arrives.
    return new Response(streamBatchedChatCompletion(resultPromise), {
      headers: SSE_HEADERS,
    });
  }

  // Non-streaming: block until complete, return JSON
  const result = await resultPromise;
  if (!result.ok) {
    return formatOpenAIError(result.error);
  }

  const completion = responsesToChatCompletion(result.data);
  return Response.json(completion);
}
