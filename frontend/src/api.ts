import { log } from "$shared/logger.ts";

export interface Job {
  id: string;
  sailResponseId: string;
  status: string;
  model: string;
  completionWindow: string;
  apiType: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  pollCount: number;
  hasError: boolean;
}

export interface JobDetail extends Job {
  requestBody: string | null;
  responseBody: string | null;
  errorBody: string | null;
}

export interface JobsResponse {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

export interface SailModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface SailModelsResponse {
  object: string;
  data: SailModel[];
}

export async function fetchJobs(
  params: { limit?: number; offset?: number; status?: string } = {},
): Promise<JobsResponse> {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.offset) search.set("offset", String(params.offset));
  if (params.status) search.set("status", params.status);
  try {
    const res = await fetch(`/api/dashboard/jobs?${search}`);
    return res.json();
  } catch (e) {
    log.error("Failed to fetch jobs:", e);
    throw e;
  }
}

export async function fetchJob(id: string): Promise<JobDetail> {
  try {
    const res = await fetch(`/api/dashboard/jobs/${id}`);
    return res.json();
  } catch (e) {
    log.error("Failed to fetch job:", id, e);
    throw e;
  }
}

export async function fetchModels(): Promise<SailModelsResponse> {
  try {
    const res = await fetch(`/api/models`);
    return res.json();
  } catch (e) {
    log.error("Failed to fetch models:", e);
    throw e;
  }
}

export type JobUpdateCallback = (job: Job) => void;

/**
 * Connect to the WebSocket endpoint for real-time job updates.
 * Returns a cleanup function that closes the connection.
 * Automatically reconnects on disconnect with exponential backoff.
 */
export function connectJobUpdates(onUpdate: JobUpdateCallback): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let reconnectDelay = 1000;

  function connect() {
    if (disposed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/dashboard`);

    ws.addEventListener("open", () => {
      reconnectDelay = 1000; // reset backoff on successful connect
      log.info("WebSocket connected");
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "job_update" && msg.data) {
          onUpdate(msg.data as Job);
        }
      } catch (e) {
        log.warn("Malformed WebSocket message:", e);
      }
    });

    ws.addEventListener("close", () => {
      if (disposed) return;
      log.info("WebSocket disconnected, reconnecting in", reconnectDelay, "ms");
      // Reconnect with backoff
      setTimeout(() => {
        if (!disposed) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });

    ws.addEventListener("error", () => {
      log.warn("WebSocket error");
      // error is followed by close, which triggers reconnect
    });
  }

  connect();

  return () => {
    disposed = true;
    if (ws) {
      ws.close();
      ws = null;
    }
  };
}
