/**
 * Centralised lists of request fields that must be removed before forwarding
 * a body to Sail. Each call site previously had its own delete-block; a
 * forgotten entry caused commit 588cddb (`store=false` leaked through and
 * Sail returned 400). Keeping the lists here means any new
 * upstream-only field is dropped in one place.
 */

/**
 * Fields the Anthropic Messages API accepts that Sail's Messages /
 * Responses APIs don't understand. Used for both the asap passthrough to
 * Sail's /v1/messages and the batched path that transforms Messages →
 * Responses (the transform input is also stripped first to keep
 * messagesToResponsesAPI's input clean).
 */
export const SAIL_MESSAGES_DROP_FIELDS = [
  "stream",
  "system",
  "thinking",
  "tools",
  "tool_choice",
  "stop_sequences",
  "top_k",
  "service_tier",
  "inference_geo",
] as const;

/**
 * Fields OpenAI's Chat Completions API accepts that Sail's /v1/chat/completions
 * doesn't understand. `max_tokens` is dropped here but callers should remap
 * it to `max_completion_tokens` first if needed.
 */
export const SAIL_CHAT_DROP_FIELDS = [
  "stream",
  "store",
  "prompt_cache_key",
  "prompt_cache_retention",
  "stream_options",
] as const;

/**
 * Returns a shallow copy of `body` with every entry in `fields` removed.
 * Mutating delete on a caller-provided object can leak through to the
 * dashboard's persisted requestBody, so always copy first.
 */
export function dropFields<T extends Record<string, unknown>>(
  body: T,
  fields: readonly string[],
): T {
  const copy = { ...body };
  for (const f of fields) delete (copy as Record<string, unknown>)[f];
  return copy;
}

/** Convenience wrapper for messages bodies. */
export function stripForSailMessages<T extends Record<string, unknown>>(
  body: T,
): T {
  return dropFields(body, SAIL_MESSAGES_DROP_FIELDS);
}

/** Convenience wrapper for chat completions bodies. */
export function stripForSailChatCompletions<T extends Record<string, unknown>>(
  body: T,
): T {
  return dropFields(body, SAIL_CHAT_DROP_FIELDS);
}
