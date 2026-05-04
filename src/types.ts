export type CompletionWindow = "asap" | "priority" | "standard" | "flex";

export type JobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Map a Sail upstream status to our JobStatus enum. */
export function mapSailStatus(status: string): JobStatus {
  if (status === "in_progress") return "running";
  return status as JobStatus;
}

export interface JobWaiter {
  resolve: (result: any) => void;
  reject: (error: any) => void;
  createdAt: number;
}

// --- Model Research Schema Types ---

/** Allowed values in a sampling preset's `params` object. */
export type SamplingParamValue = number | string | boolean;

/** A single sampling preset as returned by the pi subprocess. */
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
}
