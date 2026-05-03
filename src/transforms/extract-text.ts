/**
 * Walk a Sail Responses API output array and collect every output_text
 * fragment from message items. Returns the raw fragments (no joining) so
 * callers can decide how to format. If no structured output_text fragments
 * exist, falls back to the first item with a `.text` property — this handles
 * older or simpler response shapes where the model returned a single text
 * block at the top level.
 *
 * Returns [] for non-array inputs; null/string handling lives at call sites
 * where the output type carries semantic meaning (chat completions: null
 * means "no content", messages: must always return a content block).
 */
export function extractTextFragments(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const texts: string[] = [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && part.text) texts.push(part.text);
      }
    }
  }
  if (texts.length > 0) return texts;
  for (const item of output) {
    if (item?.text) return [item.text];
  }
  return [];
}
