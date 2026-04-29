import { test, expect, describe } from "bun:test";
import {
  isValidCompletionWindow,
  extractWindowPrefix,
  resolveCompletionWindow,
  COMPLETION_WINDOWS,
} from "./completion-window.ts";
import type { CompletionWindow } from "./types.ts";

describe("isValidCompletionWindow", () => {
  test.each([...COMPLETION_WINDOWS] as CompletionWindow[])(
    "returns true for '%s'",
    (window) => {
      expect(isValidCompletionWindow(window)).toBe(true);
    },
  );

  test("returns false for invalid values", () => {
    expect(isValidCompletionWindow("urgent")).toBe(false);
    expect(isValidCompletionWindow("")).toBe(false);
    expect(isValidCompletionWindow("ASAP")).toBe(false);
  });
});

describe("extractWindowPrefix", () => {
  test.each([...COMPLETION_WINDOWS] as CompletionWindow[])(
    "extracts '%s' from /%s/v1/chat/completions",
    (window) => {
      expect(extractWindowPrefix(`/${window}/v1/chat/completions`)).toBe(
        window,
      );
    },
  );

  test("returns null for unprefixed /v1/ paths", () => {
    expect(extractWindowPrefix("/v1/chat/completions")).toBeNull();
  });

  test("returns null for invalid prefix", () => {
    expect(extractWindowPrefix("/urgent/v1/chat/completions")).toBeNull();
  });

  test("returns null for paths without /v1/", () => {
    expect(extractWindowPrefix("/asap/chat/completions")).toBeNull();
  });

  test("extracts from /models path too", () => {
    expect(extractWindowPrefix("/flex/v1/models")).toBe("flex");
  });
});

describe("resolveCompletionWindow", () => {
  test("prefix takes highest priority", () => {
    const result = resolveCompletionWindow(
      "flex",
      "asap",
      { completion_window: "priority" },
      "standard",
    );
    expect(result).toEqual({ window: "flex", source: "prefix" });
  });

  test("header wins when no prefix", () => {
    const result = resolveCompletionWindow(
      null,
      "priority",
      { completion_window: "flex" },
      "standard",
    );
    expect(result).toEqual({ window: "priority", source: "header" });
  });

  test("metadata wins when no prefix or header", () => {
    const result = resolveCompletionWindow(
      null,
      null,
      { completion_window: "flex" },
      "standard",
    );
    expect(result).toEqual({ window: "flex", source: "metadata" });
  });

  test("default is used when nothing else is provided", () => {
    const result = resolveCompletionWindow(null, null, undefined, "standard");
    expect(result).toEqual({ window: "standard", source: "default" });
  });

  test("default is used when metadata has no completion_window", () => {
    const result = resolveCompletionWindow(null, null, {}, "standard");
    expect(result).toEqual({ window: "standard", source: "default" });
  });

  test("prefix overrides even with empty header and metadata", () => {
    const result = resolveCompletionWindow("asap", null, undefined, "flex");
    expect(result).toEqual({ window: "asap", source: "prefix" });
  });

  test("header with empty string falls through to metadata", () => {
    const result = resolveCompletionWindow(
      null,
      "",
      { completion_window: "flex" },
      "standard",
    );
    expect(result).toEqual({ window: "flex", source: "metadata" });
  });
});
