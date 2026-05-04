export type CompletionWindow = "asap" | "priority" | "standard" | "flex";

export type JobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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

/** The full JSON object expected from pi research output. */
export interface ModelResearchResult {
  contextSize: number | null;
  samplingPresets: SamplingPresetInput[];
  description: string | null;
  source: string | null;
}
