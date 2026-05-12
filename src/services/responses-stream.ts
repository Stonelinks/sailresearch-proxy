import { log } from "../../shared/logger.ts";
import { formatSSE } from "./stream.ts";
import { extractTextFragments } from "../transforms/extract-text.ts";
import type { BatchResult } from "./batch-submit.ts";
import { heartbeatStream } from "./heartbeat-stream.ts";

const encoder = new TextEncoder();

/**
 * Synthesize OpenAI Responses API streaming events from a complete
 * Sail response object. This is the streaming equivalent of returning
 * the JSON response — we emit the same data as a sequence of typed
 * SSE events matching the Responses API streaming spec.
 *
 * Event types emitted (in order):
 *  1. response.created       — full response object with status=in_progress
 *  2. response.output_item.added — for each output item (message, function_call)
 *  3. response.content_part.added — for each content part within message items
 *  4. response.output_text.delta  — text content in chunks
 *  5. response.content_part.done  — completed content part
 *  6. response.output_item.done   — completed output item
 *  7. response.completed     — full response object with status=completed
 */
export function synthesizeResponsesStreamEvents(sailResp: any): string[] {
  const events: string[] = [];
  const respId = sailResp.id;
  const model = sailResp.model;
  const createdAt = sailResp.created_at ?? Math.floor(Date.now() / 1000);

  // 1. response.created — initial response with in_progress status
  events.push(
    formatSSE({
      type: "response.created",
      response: {
        ...sailResp,
        status: "in_progress",
        created_at: createdAt,
      },
    }),
  );

  const output = Array.isArray(sailResp.output) ? sailResp.output : [];

  for (let itemIdx = 0; itemIdx < output.length; itemIdx++) {
    const item = output[itemIdx];
    const outputIndex = itemIdx;

    // 2. response.output_item.added
    events.push(
      formatSSE({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          ...item,
          status: "in_progress",
        },
      }),
    );

    if (item.type === "message" && Array.isArray(item.content)) {
      for (let partIdx = 0; partIdx < item.content.length; partIdx++) {
        const part = item.content[partIdx];

        // 3. response.content_part.added
        events.push(
          formatSSE({
            type: "response.content_part.added",
            output_index: outputIndex,
            content_index: partIdx,
            part: { ...part, text: "" },
          }),
        );

        // 4. response.output_text.delta
        if (part.type === "output_text" && part.text) {
          // Emit the full text as a single delta — we don't have
          // incremental tokens from the Sail response.
          events.push(
            formatSSE({
              type: "response.output_text.delta",
              output_index: outputIndex,
              content_index: partIdx,
              delta: part.text,
            }),
          );
        }

        // 5. response.content_part.done
        events.push(
          formatSSE({
            type: "response.content_part.done",
            output_index: outputIndex,
            content_index: partIdx,
            part,
          }),
        );
      }
    }

    // 6. response.output_item.done
    events.push(
      formatSSE({
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    );
  }

  // 7. response.completed
  events.push(
    formatSSE({
      type: "response.completed",
      response: sailResp,
    }),
  );

  return events;
}

/**
 * Create a ReadableStream that sends SSE comment heartbeats while waiting
 * for the batch result, then emits Responses API streaming events when
 * the result arrives.
 */
export function streamBatchedResponses(
  resultPromise: Promise<BatchResult>,
): ReadableStream<Uint8Array> {
  const { stream: heartbeatReadable, result } = heartbeatStream(resultPromise);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Pipe heartbeats while waiting
      const reader = heartbeatReadable.getReader();
      const heartbeatDone = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch {
          // Heartbeat stream cancelled or errored
        }
      })();

      const batchResult = await result;

      // Stop heartbeats
      reader.cancel();
      await heartbeatDone;

      if (!batchResult.ok) {
        const errorData = {
          type: "error",
          error: {
            type: batchResult.error.type,
            message: batchResult.error.message,
          },
        };
        controller.enqueue(encoder.encode(formatSSE(errorData)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      // Emit Responses API streaming events
      const events = synthesizeResponsesStreamEvents(batchResult.data);
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    cancel() {
      // Client disconnected
    },
  });
}
