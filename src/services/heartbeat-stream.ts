import { config } from "../config.ts";
import { log } from "../../shared/logger.ts";
import type { BatchResult } from "./batch-submit.ts";

const encoder = new TextEncoder();

/**
 * Format an SSE comment line. Per the SSE spec (RFC 8895), lines starting
 * with `:` are comments and MUST be ignored by clients. This makes them
 * perfect for keep-alive heartbeats — they keep the TCP connection alive
 * through intermediaries (nginx, load balancers) without affecting the
 * client's event stream.
 */
export function formatSSEComment(comment: string): string {
  return `: ${comment}\n\n`;
}

/**
 * Create a ReadableStream that emits SSE comment heartbeats at a regular
 * interval while `promise` is pending, then resolves with the result.
 *
 * Once `promise` settles:
 * - On success: the heartbeat interval is cleared and the result is returned.
 * - On error: the heartbeat interval is cleared and the error is re-thrown.
 *
 * The caller is responsible for piping the result into the final SSE stream.
 */
export function heartbeatStream(promise: Promise<BatchResult>): {
  stream: ReadableStream<Uint8Array>;
  result: Promise<BatchResult>;
} {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const intervalMs = config.streaming.heartbeatIntervalMs;

  let resolveResult: (result: BatchResult) => void;
  let rejectResult: (error: any) => void;
  const resultPromise = new Promise<BatchResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Start heartbeat interval immediately
      intervalId = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(formatSSEComment("heartbeat")));
        } catch {
          // Stream already closed — stop heartbeats
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      }, intervalMs);

      // Race the underlying promise
      promise
        .then((result) => {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          resolveResult(result);
        })
        .catch((error) => {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          rejectResult(error);
        });
    },
    cancel() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  });

  return { stream, result: resultPromise };
}
