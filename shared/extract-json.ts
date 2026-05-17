/**
 * Extract a JSON object from raw LLM output.
 * Handles:
 *   - Raw JSON objects
 *   - Markdown-fenced JSON (```json ... ```)
 *   - Text before JSON on the same line or preceding lines
 *
 * Shared by research-models.ts and docs-scraper.ts.
 */
export function extractJson(raw: string): string | null {
  // Try markdown code fences first
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Find the first '{' character in the string (even if preceded by text
  // on the same line), then track brace depth to find the matching '}'.
  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) return null;

  // Reject Jinja/template syntax that starts with "{%-" or "{%" — LLMs
  // sometimes emit template code instead of JSON. The brace counter below
  // would find a matching "}" but the content is not valid JSON.
  const afterBrace = raw.slice(firstBrace, firstBrace + 3);
  if (afterBrace === "{%-" || afterBrace === "{% ") return null;

  let braceCount = 0;
  let end = -1;

  for (let i = firstBrace; i < raw.length; i++) {
    if (raw[i] === "{") {
      braceCount++;
    } else if (raw[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  return raw.slice(firstBrace, end + 1);
}
