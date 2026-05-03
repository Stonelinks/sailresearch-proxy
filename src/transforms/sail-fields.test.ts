import { describe, test, expect } from "bun:test";
import {
  dropFields,
  stripForSailMessages,
  stripForSailChatCompletions,
  SAIL_MESSAGES_DROP_FIELDS,
  SAIL_CHAT_DROP_FIELDS,
} from "./sail-fields.ts";

describe("dropFields", () => {
  test("removes listed fields and leaves others intact", () => {
    const out = dropFields({ a: 1, b: 2, c: 3 } as Record<string, number>, [
      "a",
      "c",
    ]);
    expect(out).toEqual({ b: 2 });
  });

  test("does not mutate the input", () => {
    const input = { a: 1, b: 2 };
    dropFields(input, ["a"]);
    expect(input).toEqual({ a: 1, b: 2 });
  });

  test("ignores fields that aren't present", () => {
    const out = dropFields({ a: 1 }, ["b", "c"]);
    expect(out).toEqual({ a: 1 });
  });
});

describe("stripForSailMessages", () => {
  test("drops every field in SAIL_MESSAGES_DROP_FIELDS", () => {
    const input: Record<string, unknown> = { model: "x", messages: [] };
    for (const f of SAIL_MESSAGES_DROP_FIELDS) input[f] = "x";
    const out = stripForSailMessages(input);
    for (const f of SAIL_MESSAGES_DROP_FIELDS) expect(out[f]).toBeUndefined();
    expect(out.model).toBe("x");
  });
});

describe("stripForSailChatCompletions", () => {
  test("drops every field in SAIL_CHAT_DROP_FIELDS", () => {
    const input: Record<string, unknown> = { model: "x", messages: [] };
    for (const f of SAIL_CHAT_DROP_FIELDS) input[f] = "x";
    const out = stripForSailChatCompletions(input);
    for (const f of SAIL_CHAT_DROP_FIELDS) expect(out[f]).toBeUndefined();
    expect(out.model).toBe("x");
  });

  test("does not strip max_tokens (caller remaps to max_completion_tokens first)", () => {
    const out = stripForSailChatCompletions({ model: "x", max_tokens: 100 });
    expect(out.max_tokens).toBe(100);
  });
});
