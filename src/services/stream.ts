import { config } from "../config.ts";

export function formatSSE(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function splitIntoChunks(text: string, targetSize: number): string[] {
  if (text.length <= targetSize) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + targetSize, text.length);
    // Try to break on a word boundary (space) if not at the end
    if (end < text.length) {
      const spaceIdx = text.lastIndexOf(" ", end);
      if (spaceIdx > i) end = spaceIdx + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

export function streamResponse(completion: any): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunkSize = config.streaming.chunkSize;

  return new ReadableStream({
    async start(controller) {
      const choice = completion.choices?.[0];
      const content = choice?.message?.content ?? "";
      const id = completion.id;
      const model = completion.model;
      const created = completion.created;

      // Role chunk
      controller.enqueue(
        encoder.encode(
          formatSSE({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          }),
        ),
      );

      // Content chunks
      if (content) {
        const chunks = splitIntoChunks(content, chunkSize);
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(
              formatSSE({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  { index: 0, delta: { content: chunk }, finish_reason: null },
                ],
              }),
            ),
          );
        }
      }

      // Tool-call chunks: clients expect each call as a delta with index, id,
      // type, and function.{name,arguments}. We emit one chunk per call rather
      // than splitting arguments across deltas — Sail returns the full arg
      // string at once so there's nothing to stream incrementally.
      const toolCalls = choice?.message?.tool_calls ?? [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        controller.enqueue(
          encoder.encode(
            formatSSE({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: tc.id,
                        type: "function",
                        function: {
                          name: tc.function?.name,
                          arguments: tc.function?.arguments ?? "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          ),
        );
      }

      // Final chunk with finish_reason + usage
      controller.enqueue(
        encoder.encode(
          formatSSE({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: choice?.finish_reason ?? "stop",
              },
            ],
            usage: completion.usage,
          }),
        ),
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
