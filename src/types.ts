export type CompletionWindow = "asap" | "priority" | "standard" | "flex";

// --- Model Research Schema Types ---

/** Allowed values in a sampling preset's `params` object. */
export type SamplingParamValue = number | string | boolean;

/** A single sampling preset as returned by the research LLM. */
export interface SamplingPresetInput {
  name: string;
  description: string;
  params: Record<string, SamplingParamValue>;
}

/** A per-completion-window price entry from pi research output. */
export interface ModelPriceInput {
  completionWindow: CompletionWindow;
  inputPerMTok: number;
  cachedInputPerMTok: number | null;
  outputPerMTok: number;
}

/** The full JSON object expected from pi research output. */
export interface ModelResearchResult {
  contextSize: number | null;
  samplingPresets: SamplingPresetInput[];
  prices: ModelPriceInput[];
  description: string | null;
  source: string | null;
  supportsImage: boolean;
  reasoning: boolean;
  thinkingLevelMap: Record<string, string | null> | null;
  supportedWindows: CompletionWindow[] | null;
}
