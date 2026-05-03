import { describe, test, expect } from "bun:test";
import { extractTextFragments } from "./extract-text.ts";

describe("extractTextFragments", () => {
  test("returns [] for non-array input", () => {
    expect(extractTextFragments(null)).toEqual([]);
    expect(extractTextFragments(undefined)).toEqual([]);
    expect(extractTextFragments("a string")).toEqual([]);
    expect(extractTextFragments({})).toEqual([]);
  });

  test("collects every output_text fragment from message items", () => {
    const out = extractTextFragments([
      {
        type: "message",
        content: [
          { type: "output_text", text: "Hello " },
          { type: "output_text", text: "world" },
        ],
      },
    ]);
    expect(out).toEqual(["Hello ", "world"]);
  });

  test("collects across multiple message items", () => {
    const out = extractTextFragments([
      {
        type: "message",
        content: [{ type: "output_text", text: "first" }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "second" }],
      },
    ]);
    expect(out).toEqual(["first", "second"]);
  });

  test("ignores non-output_text parts", () => {
    const out = extractTextFragments([
      {
        type: "message",
        content: [
          { type: "input_image", image_url: "..." },
          { type: "output_text", text: "kept" },
        ],
      },
    ]);
    expect(out).toEqual(["kept"]);
  });

  test("falls back to first item with raw .text when no output_text", () => {
    const out = extractTextFragments([{ text: "fallback text" }]);
    expect(out).toEqual(["fallback text"]);
  });

  test("returns [] when neither output_text nor raw .text is present", () => {
    expect(
      extractTextFragments([
        { type: "function_call", call_id: "c1", name: "x" },
      ]),
    ).toEqual([]);
  });

  test("ignores empty output_text strings", () => {
    const out = extractTextFragments([
      {
        type: "message",
        content: [{ type: "output_text", text: "" }],
      },
    ]);
    expect(out).toEqual([]);
  });
});
