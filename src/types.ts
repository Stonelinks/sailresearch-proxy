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
