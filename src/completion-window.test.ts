import { test, expect, describe } from "bun:test";
import {
  isValidCompletionWindow,
  normalizeCompletionWindow,
  extractWindowPrefix,
  rawWindowPrefix,
  resolveCompletionWindow,
  COMPLETION_WINDOWS,
  LEGACY_WINDOW_ALIASES,
} from "./completion-window.ts";
import type { CompletionWindow } from "./types.ts";

describe("COMPLETION_WINDOWS", () => {
  test("is Sail's current tier list, fastest first", () => {
    expect([...COMPLETION_WINDOWS]).toEqual(["asap", "balanced", "flex"]);
  });

  test("legacy aliases never overlap current names", () => {
    for (const legacy of Object.keys(LEGACY_WINDOW_ALIASES)) {
      expect(isValidCompletionWindow(legacy)).toBe(false);
    }
  });
});

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

  test("returns false for retired tier names", () => {
    expect(isValidCompletionWindow("priority")).toBe(false);
    expect(isValidCompletionWindow("standard")).toBe(false);
  });
});

describe("normalizeCompletionWindow", () => {
  test.each([...COMPLETION_WINDOWS] as CompletionWindow[])(
    "passes '%s' through unchanged",
    (window) => {
      expect(normalizeCompletionWindow(window)).toBe(window);
    },
  );

  test("aliases retired 'priority' to balanced", () => {
    expect(normalizeCompletionWindow("priority")).toBe("balanced");
  });

  test("aliases retired 'standard' to balanced", () => {
    expect(normalizeCompletionWindow("standard")).toBe("balanced");
  });

  test("returns null for unknown values", () => {
    expect(normalizeCompletionWindow("urgent")).toBeNull();
    expect(normalizeCompletionWindow("")).toBeNull();
    expect(normalizeCompletionWindow("ASAP")).toBeNull();
    expect(normalizeCompletionWindow("Balanced")).toBeNull();
  });
});

describe("rawWindowPrefix", () => {
  test("returns the first segment of /{segment}/v1/ paths without validating", () => {
    expect(rawWindowPrefix("/asap/v1/chat/completions")).toBe("asap");
    expect(rawWindowPrefix("/priority/v1/chat/completions")).toBe("priority");
    expect(rawWindowPrefix("/urgent/v1/chat/completions")).toBe("urgent");
  });

  test("returns null when the path is not window-prefixed", () => {
    expect(rawWindowPrefix("/v1/chat/completions")).toBeNull();
    expect(rawWindowPrefix("/asap/chat/completions")).toBeNull();
    expect(rawWindowPrefix("/health")).toBeNull();
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

  test("maps retired prefixes to their replacement window", () => {
    expect(extractWindowPrefix("/priority/v1/chat/completions")).toBe(
      "balanced",
    );
    expect(extractWindowPrefix("/standard/v1/messages")).toBe("balanced");
  });

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
      { completion_window: "balanced" },
      "balanced",
    );
    expect(result).toEqual({ window: "flex", source: "prefix" });
  });

  test("header wins when no prefix", () => {
    const result = resolveCompletionWindow(
      null,
      "asap",
      { completion_window: "flex" },
      "balanced",
    );
    expect(result).toEqual({ window: "asap", source: "header" });
  });

  test("metadata wins when no prefix or header", () => {
    const result = resolveCompletionWindow(
      null,
      null,
      { completion_window: "flex" },
      "balanced",
    );
    expect(result).toEqual({ window: "flex", source: "metadata" });
  });

  test("default is used when nothing else is provided", () => {
    const result = resolveCompletionWindow(null, null, undefined, "balanced");
    expect(result).toEqual({ window: "balanced", source: "default" });
  });

  test("default is used when metadata has no completion_window", () => {
    const result = resolveCompletionWindow(null, null, {}, "balanced");
    expect(result).toEqual({ window: "balanced", source: "default" });
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
      "balanced",
    );
    expect(result).toEqual({ window: "flex", source: "metadata" });
  });

  test("legacy header value is aliased, not forwarded verbatim", () => {
    const result = resolveCompletionWindow(null, "priority", undefined, "asap");
    expect(result).toEqual({ window: "balanced", source: "header" });
  });

  test("legacy metadata value is aliased, not forwarded verbatim", () => {
    const result = resolveCompletionWindow(
      null,
      null,
      { completion_window: "standard" },
      "asap",
    );
    expect(result).toEqual({ window: "balanced", source: "metadata" });
  });

  test("unknown header value falls through to metadata", () => {
    const result = resolveCompletionWindow(
      null,
      "urgent",
      { completion_window: "flex" },
      "balanced",
    );
    expect(result).toEqual({ window: "flex", source: "metadata" });
  });

  test("unknown metadata value falls through to default", () => {
    const result = resolveCompletionWindow(
      null,
      null,
      { completion_window: "urgent" },
      "balanced",
    );
    expect(result).toEqual({ window: "balanced", source: "default" });
  });
});
