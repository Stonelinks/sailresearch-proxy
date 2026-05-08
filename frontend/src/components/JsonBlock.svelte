<script lang="ts">
  /**
   * JsonBlock — syntax-highlighted JSON display with optional copy button.
   *
   * - `json`: raw JSON string (will be pretty-printed) or pre-formatted string
   * - `copy`: show a "click to copy" button (default true for short content)
   * - `error`: style as error text (red tones)
   * - `maxLines`: if set, collapse beyond this many lines with a "show more" toggle
   */
  let {
    json,
    copy = true,
    error = false,
    maxLines = undefined as number | undefined,
  }: {
    json: string;
    copy?: boolean;
    error?: boolean;
    maxLines?: number;
  } = $props();

  let copied = $state(false);
  let expanded = $state(false);

  const LINE_HEIGHT_EM = 1.625; // leading-relaxed
  const PX_TOP = 16; // p-4

  let formatted = $derived(() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  });

  let lineCount = $derived(formatted().split("\n").length);

  let isTruncated = $derived(
    maxLines !== undefined && lineCount > maxLines && !expanded,
  );

  let displayed = $derived(
    isTruncated
      ? formatted()
          .split("\n")
          .slice(0, maxLines!)
          .join("\n") + "\n  …"
      : formatted(),
  );

  let collapseThreshold = $derived(lineCount > 12);
  let showCopy = $derived(copy && formatted().length < 10_000);

  function handleCopy() {
    navigator.clipboard.writeText(formatted());
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  /**
   * Tokenize a JSON string into coloured spans.
   * We do this with a simple regex walk — no AST needed for display.
   */
  function highlight(src: string): string {
    // Escape HTML first
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Tokens: strings, numbers, booleans, null, punctuation, whitespace
    const tokenRe =
      /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])|(\s+)/g;

    let out = "";
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = tokenRe.exec(src)) !== null) {
      // Any raw text between last match and this one (shouldn't happen, but safety)
      if (match.index > lastIndex) {
        out += esc(src.slice(lastIndex, match.index));
      }
      lastIndex = match.index + match[0].length;

      const [
        ,
        keyMatch,
        stringMatch,
        numberMatch,
        literalMatch,
        punctMatch,
        wsMatch,
      ] = match;

      if (keyMatch !== undefined) {
        // Object key — include the colon in the match
        out += `<span class="jb-key">${esc(keyMatch)}</span><span class="jb-punct">:</span>`;
      } else if (stringMatch !== undefined) {
        out += `<span class="jb-string">${esc(stringMatch)}</span>`;
      } else if (numberMatch !== undefined) {
        out += `<span class="jb-number">${esc(numberMatch)}</span>`;
      } else if (literalMatch !== undefined) {
        out += `<span class="jb-literal">${esc(literalMatch)}</span>`;
      } else if (punctMatch !== undefined) {
        out += `<span class="jb-punct">${esc(punctMatch)}</span>`;
      } else if (wsMatch !== undefined) {
        out += wsMatch; // preserve whitespace as-is
      }
    }

    // Trailing text
    if (lastIndex < src.length) {
      out += esc(src.slice(lastIndex));
    }

    return out;
  }

  let highlighted = $derived(highlight(displayed));
</script>

<div
  class="jb-root group relative {error ? 'jb-error' : ''}"
  style:max-height={isTruncated ? `${maxLines! * LINE_HEIGHT_EM}em` : undefined}
>
  {#if showCopy}
    <button
      onclick={handleCopy}
      class="jb-copy"
      title="Copy to clipboard"
    >
      {#if copied}
        <svg class="jb-copy-icon" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
        </svg>
        <span class="jb-copy-label text-emerald-500">Copied</span>
      {:else}
        <svg class="jb-copy-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="6" y="6" width="10" height="10" rx="1.5" />
          <path d="M3 13V4a1 1 0 011-1h9" />
        </svg>
        <span class="jb-copy-label">Copy</span>
      {/if}
    </button>
  {/if}

  <pre
    class="jb-pre"
  ><code>{@html highlighted}</code></pre>

  {#if isTruncated}
    <button
      onclick={() => (expanded = true)}
      class="jb-expand"
    >
      Show all {lineCount} lines ↓
    </button>
  {:else if expanded && maxLines !== undefined && lineCount > maxLines}
    <button
      onclick={() => (expanded = false)}
      class="jb-expand"
    >
      Collapse ↑
    </button>
  {/if}
</div>

<style>
  /* ---------- Root ---------- */
  .jb-root {
    position: relative;
    overflow: hidden;
    border-radius: 0.375rem;
    background: var(--jb-bg, #f8fafc);
    transition: max-height 0.3s ease;
  }
  .jb-root:not(.jb-error) {
    border: 1px solid var(--jb-border, #e2e8f0);
  }
  .jb-error {
    background: var(--jb-error-bg, #fef2f2);
    border: 1px solid var(--jb-error-border, #fecaca);
  }

  /* ---------- Pre/code ---------- */
  .jb-pre {
    margin: 0;
    padding: 1rem;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 0.75rem;
    line-height: 1.625;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    color: var(--jb-text, #334155);
  }
  .jb-error .jb-pre {
    color: var(--jb-error-text, #991b1b);
  }

  /* ---------- Syntax tokens ---------- */
  :global(.jb-key) {
    color: #0369a1; /* sky-700 */
  }
  :global(.jb-string) {
    color: #15803d; /* green-700 */
  }
  :global(.jb-number) {
    color: #c2410c; /* orange-700 */
  }
  :global(.jb-literal) {
    color: #7c3aed; /* violet-600 */
    font-style: italic;
  }
  :global(.jb-punct) {
    color: #94a3b8; /* slate-400 */
  }

  .jb-error :global(.jb-key),
  .jb-error :global(.jb-string),
  .jb-error :global(.jb-number),
  .jb-error :global(.jb-literal),
  .jb-error :global(.jb-punct) {
    color: inherit;
    font-style: normal;
  }

  /* ---------- Copy button ---------- */
  .jb-copy {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-family: "Outfit", system-ui, sans-serif;
    color: var(--jb-copy-text, #94a3b8);
    background: var(--jb-copy-bg, rgba(255, 255, 255, 0.85));
    border: 1px solid var(--jb-copy-border, #e2e8f0);
    border-radius: 0.25rem;
    cursor: pointer;
    opacity: 0;
    transform: translateY(-2px);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      color 0.15s ease,
      background 0.15s ease;
    backdrop-filter: blur(4px);
    z-index: 1;
  }
  .jb-root:hover .jb-copy,
  .jb-copy:focus-visible {
    opacity: 1;
    transform: translateY(0);
  }
  .jb-copy:hover {
    color: #475569;
    background: white;
    border-color: #cbd5e1;
  }
  .jb-copy:focus-visible {
    outline: 2px solid #7dd3fc;
    outline-offset: 1px;
  }
  .jb-copy-icon {
    width: 0.875rem;
    height: 0.875rem;
  }
  .jb-copy-label {
    line-height: 1;
  }

  /* ---------- Expand / Collapse ---------- */
  .jb-expand {
    display: block;
    width: 100%;
    padding: 0.375rem 0;
    font-size: 0.75rem;
    font-family: "Outfit", system-ui, sans-serif;
    color: #64748b;
    background: var(--jb-expand-bg, #f1f5f9);
    border: none;
    border-top: 1px solid var(--jb-border, #e2e8f0);
    cursor: pointer;
    text-align: center;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .jb-expand:hover {
    background: #e2e8f0;
    color: #334155;
  }

  /* ---------- Scrollbar (webkit) ---------- */
  .jb-pre::-webkit-scrollbar {
    height: 4px;
  }
  .jb-pre::-webkit-scrollbar-track {
    background: transparent;
  }
  .jb-pre::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 2px;
  }
  .jb-pre::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }
</style>
