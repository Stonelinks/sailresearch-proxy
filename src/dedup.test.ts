import { describe, test, expect } from "bun:test";
import { computeSailBodyHash, deterministicStringify } from "./dedup.ts";

describe("deterministicStringify", () => {
  test("serializes primitives", () => {
    expect(deterministicStringify(null)).toBe("null");
    expect(deterministicStringify(undefined)).toBeUndefined();
    expect(deterministicStringify(42)).toBe("42");
    expect(deterministicStringify("hello")).toBe('"hello"');
    expect(deterministicStringify(true)).toBe("true");
  });

  test("serializes arrays", () => {
    expect(deterministicStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  test("sorts object keys", () => {
    const result = deterministicStringify({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  test("key ordering does not affect output", () => {
    const a = deterministicStringify({ x: 1, y: 2 });
    const b = deterministicStringify({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  test("sorts nested object keys", () => {
    const result = deterministicStringify({
      metadata: { completion_window: "flex", foo: "bar" },
    });
    expect(result).toBe(
      '{"metadata":{"completion_window":"flex","foo":"bar"}}',
    );
  });

  test("handles arrays inside objects", () => {
    const result = deterministicStringify({ input: [{ role: "user" }] });
    expect(result).toBe('{"input":[{"role":"user"}]}');
  });
});

describe("computeSailBodyHash", () => {
  test("identical bodies produce identical hashes", () => {
    const body = {
      model: "deepseek-ai/DeepSeek-V3.2",
      input: [{ role: "user", content: "Hello" }],
      background: true,
      store: true,
      metadata: { completion_window: "flex" },
    };
    const hash1 = computeSailBodyHash(body);
    const hash2 = computeSailBodyHash(body);
    expect(hash1).toBe(hash2);
  });

  test("different bodies produce different hashes", () => {
    const body1 = { model: "model-a", input: "Hello" };
    const body2 = { model: "model-b", input: "Hello" };
    expect(computeSailBodyHash(body1)).not.toBe(computeSailBodyHash(body2));
  });

  test("key ordering does not affect hash", () => {
    const body1 = { model: "test", input: "hi", background: true };
    const body2 = { background: true, input: "hi", model: "test" };
    expect(computeSailBodyHash(body1)).toBe(computeSailBodyHash(body2));
  });

  test("returns a 64-char hex string (SHA-256)", () => {
    const hash = computeSailBodyHash({ model: "test" });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});
