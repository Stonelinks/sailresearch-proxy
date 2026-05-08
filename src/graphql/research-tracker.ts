/**
 * In-memory tracker for model research operations.
 *
 * Tracks which models are currently being researched (per-model refetch)
 * and optional batch progress (research-all). State changes are published
 * via the shared pubsub so GraphQL subscriptions can push real-time
 * updates to all connected clients.
 *
 * State is in-memory only — lost on server restart. Clients recover via
 * the `activeResearch` query on page load.
 */
import { pubsub } from "./pubsub.ts";

export interface BatchProgressWire {
  id: string;
  total: number;
  completed: number;
  errors: number;
}

export interface ModelResearchUpdatePayload {
  modelId: string;
  status: "started" | "completed" | "failed";
  error: string | null;
  batch: BatchProgressWire | null;
}

interface ModelEntry {
  startedAt: Date;
}

interface BatchState {
  id: string;
  total: number;
  completed: number;
  errors: number;
}

let batchCounter = 0;

class ResearchTracker {
  private models = new Map<string, ModelEntry>();
  private batch: BatchState | null = null;

  /** Record that research has started for a model. */
  startModel(modelId: string): void {
    this.models.set(modelId, { startedAt: new Date() });
    pubsub.publish("modelResearchUpdated", {
      modelId,
      status: "started",
      error: null,
      batch: this.batchWire(),
    });
  }

  /** Record that research completed successfully for a model. */
  completeModel(modelId: string): void {
    this.models.delete(modelId);
    if (this.batch) {
      this.batch.completed += 1;
      // Auto-end batch if all models accounted for
      if (this.batch.completed + this.batch.errors >= this.batch.total) {
        this.batch = null;
      }
    }
    pubsub.publish("modelResearchUpdated", {
      modelId,
      status: "completed",
      error: null,
      batch: this.batchWire(),
    });
  }

  /** Record that research failed for a model. */
  failModel(modelId: string, error: string): void {
    this.models.delete(modelId);
    if (this.batch) {
      this.batch.errors += 1;
      // Auto-end batch if all models accounted for
      if (this.batch.completed + this.batch.errors >= this.batch.total) {
        this.batch = null;
      }
    }
    pubsub.publish("modelResearchUpdated", {
      modelId,
      status: "failed",
      error,
      batch: this.batchWire(),
    });
  }

  /** Start a batch research operation. */
  startBatch(modelIds: string[]): void {
    batchCounter += 1;
    this.batch = {
      id: String(batchCounter),
      total: modelIds.length,
      completed: 0,
      errors: 0,
    };
  }

  /** Explicitly end a batch (used if the caller wants to force-end). */
  endBatch(): void {
    this.batch = null;
  }

  /** Whether a specific model is currently being researched. */
  isResearching(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /** Get all currently researching model IDs. */
  getActiveModelIds(): string[] {
    return [...this.models.keys()];
  }

  /** Get the current batch progress, if any. */
  getBatch(): BatchProgressWire | null {
    return this.batchWire();
  }

  private batchWire(): BatchProgressWire | null {
    if (!this.batch) return null;
    return { ...this.batch };
  }
}

export const researchTracker = new ResearchTracker();
