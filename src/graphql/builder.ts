import SchemaBuilder from "@pothos/core";
import type { PrismaClient } from "@prisma/client";
import type { JobSummary, JobDetail } from "../services/job-shapes.ts";
import type { ModelWire, PresetWire, PriceWire } from "../models-meta.ts";
import type { pubsub } from "./pubsub.ts";
import type {
  ModelResearchUpdatePayload,
  BatchProgressWire,
} from "./research-tracker.ts";

type ActiveResearchWire = {
  modelIds: string[];
  batch: BatchProgressWire | null;
};

export type {
  ModelWire,
  PresetWire,
  PriceWire,
  ActiveResearchWire,
  ModelResearchUpdatePayload,
  BatchProgressWire,
};

export interface Context {
  prisma: PrismaClient;
  pubsub: typeof pubsub;
}

export const builder = new SchemaBuilder<{
  Context: Context;
  DefaultFieldNullability: false;
  Objects: {
    Job: JobSummary;
    JobDetail: JobDetail;
    Model: ModelWire;
    SamplingPreset: PresetWire;
    ModelPrice: PriceWire;
    BatchProgress: BatchProgressWire;
    ModelResearchUpdate: ModelResearchUpdatePayload;
    ActiveResearch: ActiveResearchWire;
  };
  Scalars: {
    /** ISO 8601 date string. */
    DateTime: { Input: string; Output: string };
    /** JSON-encoded value for sampling preset params. */
    JSON: {
      Input: Record<string, number | string | boolean>;
      Output: Record<string, number | string | boolean>;
    };
    ID: { Input: string; Output: string };
  };
}>({
  defaultFieldNullability: false,
});

builder.scalarType("DateTime", {
  serialize: (value) => value,
  parseValue: (value) => {
    if (typeof value !== "string") {
      throw new Error("DateTime must be an ISO 8601 string");
    }
    return value;
  },
});

builder.scalarType("JSON", {
  serialize: (value) => value,
  parseValue: (value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("JSON scalar must be an object");
    }
    return value as Record<string, number | string | boolean>;
  },
});
