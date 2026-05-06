/**
 * Extract a JSON object from raw LLM output.
 * Handles both raw JSON and markdown-fenced JSON.
 *
 * Shared by research-models.ts and docs-scraper.ts.
 */
export function extractJson(raw: string): string | null {
  // Try markdown code fences first
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Try raw JSON object (first { ... } block)
  const lines = raw.split("\n");
  let start = -1;
  let braceCount = 0;
  const jsonLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (start === -1) {
      if (line.trimStart().startsWith("{")) {
        start = i;
        braceCount += (line.match(/{/g) ?? []).length;
        braceCount -= (line.match(/}/g) ?? []).length;
        jsonLines.push(line);
        if (braceCount === 0) break;
      }
    } else {
      braceCount += (line.match(/{/g) ?? []).length;
      braceCount -= (line.match(/}/g) ?? []).length;
      jsonLines.push(line);
      if (braceCount === 0) break;
    }
  }

  if (jsonLines.length > 0) {
    return jsonLines.join("\n");
  }

  return null;
}
