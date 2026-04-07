export type CompletionWindow = "asap" | "15m" | "24h";

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
