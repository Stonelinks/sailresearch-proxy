import { formatSSE } from "./stream.ts";
import { extractTextFragments } from "../transforms/extract-text.ts";
import type { BatchResult } from "./batch-submit.ts";
import { heartbeatStream } from "./heartbeat-stream.ts";

const encoder = new TextEncoder();

/**
 * Synthesize Anthropic Messages API streaming events from a complete
 * Sail response object. Emits the standard Anthropic SSE event sequence
 * matching what the Anthropic API returns when `stream: true`.
 *
 * Event types emitted (in order):
 *  1. message_start     — initial message metadata
 *  2. content_block_start — text block begins
 *  3. content_block_delta — text content chunks
 *  4. content_block_stop   — text block ends
 *  5. message_delta     — final stop_reason + usage
 *  6. message_stop      — message complete
 */
export function synthesizeAnthropicStreamEvents(sailResp: any): string[] {
  const events: string[] = [];
  const msgId = sailResp.id;
  const model = sailResp.model;

  const text = extractTextFragments(sailResp.output).join("");

  // 1. message_start
  events.push(
    formatSSE({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: sailResp.usage?.input_tokens ?? 0,
          output_tokens: 0,
        },
      },
    }),
  );

  // 2. content_block_start
  events.push(
    formatSSE({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );

  // 3. content_block_delta — emit the full text as a single delta
  // (Sail returns the complete result, no incremental tokens)
  if (text) {
    events.push(
      formatSSE({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    );
  }

  // 4. content_block_stop
  events.push(
    formatSSE({
      type: "content_block_stop",
      index: 0,
    }),
  );

  // 5. message_delta
  events.push(
    formatSSE({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        output_tokens: sailResp.usage?.output_tokens ?? 0,
      },
    }),
  );

  // 6. message_stop
  events.push(
    formatSSE({
      type: "message_stop",
    }),
  );

  return events;
}

/**
 * Create a ReadableStream that sends SSE comment heartbeats while waiting
 * for the batch result, then emits Anthropic Messages API streaming events
 * when the result arrives.
 */
export function streamBatchedMessages(
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
            type: "api_error",
            message: batchResult.error.message,
          },
        };
        controller.enqueue(encoder.encode(formatSSE(errorData)));
        controller.close();
        return;
      }

      // Emit Anthropic Messages API streaming events
      const events = synthesizeAnthropicStreamEvents(batchResult.data);
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }

      controller.close();
    },
    cancel() {
      // Client disconnected
    },
  });
}
