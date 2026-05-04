import SchemaBuilder from "@pothos/core";
import type { PrismaClient } from "@prisma/client";
import type { JobSummary, JobDetail } from "../services/job-shapes.ts";
import type { pubsub } from "./pubsub.ts";

/** Wire shape for sampling presets returned by the dashboard. params is parsed. */
export interface PresetWire {
  name: string;
  description: string;
  params: Record<string, number | string | boolean>;
}

/** Wire shape for a model row returned by the dashboard. Sail fields + meta. */
export interface ModelWire {
  id: string;
  object: string;
  created: number;
  ownedBy: string;
  contextSize: number | null;
  samplingPresets: PresetWire[] | null;
  description: string | null;
  source: string | null;
  researchedAt: string | null;
}

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
