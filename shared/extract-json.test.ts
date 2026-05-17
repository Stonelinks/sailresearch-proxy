import { describe, test, expect } from "bun:test";
import { extractJson } from "./extract-json.ts";

describe("extractJson", () => {
  test("extracts a raw JSON object", () => {
    const raw = '{"contextSize": 131072, "reasoning": false}';
    expect(extractJson(raw)).toBe(raw);
  });

  test("extracts JSON from markdown fences", () => {
    const raw = '```json\n{"contextSize": 131072}\n```';
    expect(extractJson(raw)).toBe('{"contextSize": 131072}');
  });

  test("extracts JSON from markdown fences without language tag", () => {
    const raw = '```\n{"contextSize": 131072}\n```';
    expect(extractJson(raw)).toBe('{"contextSize": 131072}');
  });

  test("extracts JSON preceded by text on the same line", () => {
    const raw =
      'Let me extract the data.{"contextSize": 131072, "reasoning": false}';
    expect(extractJson(raw)).toBe(
      '{"contextSize": 131072, "reasoning": false}',
    );
  });

  test("extracts JSON preceded by text on multiple lines", () => {
    const raw =
      'Here is the data you requested.\nNow extracting...\n{"contextSize": 131072}';
    expect(extractJson(raw)).toBe('{"contextSize": 131072}');
  });

  test("extracts nested JSON objects", () => {
    const raw = 'Commentary before.{"outer": {"inner": 42}, "list": [1, 2, 3]}';
    expect(extractJson(raw)).toBe(
      '{"outer": {"inner": 42}, "list": [1, 2, 3]}',
    );
  });

  test("returns null when no JSON found", () => {
    expect(extractJson("no json here")).toBeNull();
  });

  test("returns null for unmatched opening brace", () => {
    expect(extractJson('{"broken": true')).toBeNull();
  });

  test("extracts JSON with strings containing braces", () => {
    const raw = '{"text": "hello {world}"}';
    // Note: this is a known limitation — simple brace counting doesn't
    // understand string contexts. The function will find the first { and
    // match to the first } that balances, which in this case works correctly
    // because the inner braces are matched.
    expect(extractJson(raw)).toBe('{"text": "hello {world}"}');
  });

  test("extracts first JSON object when multiple exist", () => {
    const raw = '{"first": 1} and {"second": 2}';
    expect(extractJson(raw)).toBe('{"first": 1}');
  });

  test("returns null for Jinja template syntax", () => {
    expect(extractJson("{%- if condition %}output{% endif %}")).toBeNull();
    expect(extractJson("{% if condition %}output{% endif %}")).toBeNull();
  });

  test("handles real LLM pricing scrape output", () => {
    const raw =
      'Let me check if there are any local files with the full pricing data, since the HTML provided is truncated.Now I have the complete pricing page. Let me extract all the data carefully.{"models":[{"modelId":"test/model","prices":[]}]}';
    const result = extractJson(raw);
    expect(result).toBe('{"models":[{"modelId":"test/model","prices":[]}]}');
    // Verify it's valid JSON
    expect(() => JSON.parse(result!)).not.toThrow();
  });
});
