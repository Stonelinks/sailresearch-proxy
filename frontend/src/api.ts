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

export interface SamplingPresetParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: number | string | boolean | undefined;
}

export interface SamplingPreset {
  name: string;
  description: string;
  params: SamplingPresetParams;
}

export interface SailModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  contextSize: number | null;
  samplingPresets: SamplingPreset[] | null;
  description: string | null;
  source: string | null;
  researchedAt: string | null;
}

export interface SailModelsResponse {
  object: string;
  data: SailModel[];
}

/**
 * Single fetch surface for the dashboard SPA. Throws on non-2xx instead of
 * returning the success-shaped JSON, which previously crashed callers
 * downstream on undefined fields. The body of the failed response is
 * included in the error message to make 500s debuggable from the console.
 */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    log.error(`fetch ${path} threw:`, e);
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = `${path} returned ${res.status}: ${text || res.statusText}`;
    log.error(msg);
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function fetchJobs(
  params: { limit?: number; offset?: number; status?: string } = {},
): Promise<JobsResponse> {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.offset) search.set("offset", String(params.offset));
  if (params.status) search.set("status", params.status);
  return fetchJson<JobsResponse>(`/api/dashboard/jobs?${search}`);
}

export async function fetchJob(id: string): Promise<JobDetail> {
  return fetchJson<JobDetail>(`/api/dashboard/jobs/${id}`);
}

export async function fetchModels(): Promise<SailModelsResponse> {
  return fetchJson<SailModelsResponse>(`/api/models`);
}

export type JobUpdateCallback = (job: Job) => void;
export type ConnectCallback = () => void;

/**
 * Connect to the WebSocket endpoint for real-time job updates.
 * Returns a cleanup function that closes the connection.
 * Automatically reconnects on disconnect with exponential backoff.
 * `onConnect` is called when the server confirms the connection (or on open).
 */
export function connectJobUpdates(
  onUpdate: JobUpdateCallback,
  onConnect?: ConnectCallback,
  onDisconnect?: ConnectCallback,
): () => void {
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
        if (msg.type === "connected") {
          onConnect?.();
        } else if (msg.type === "job_update" && msg.data) {
          onUpdate(msg.data as Job);
        }
      } catch (e) {
        log.warn("Malformed WebSocket message:", e);
      }
    });

    ws.addEventListener("close", () => {
      if (disposed) return;
      onDisconnect?.();
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
