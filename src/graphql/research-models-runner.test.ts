/**
 * researchAndUpsertOne's subscription events must not wait on the window
 * compatibility probes, whose flex request can take 2 h.
 */
import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import * as researchModels from "../research-models.ts";
import * as docsScraper from "../docs-scraper.ts";
import type { SmokeTestResult, WindowProbes } from "../research-models.ts";
import type { ModelResearchResult } from "../types.ts";
import { pubsub } from "./pubsub.ts";
import type { ModelResearchUpdatePayload } from "./research-tracker.ts";
import { researchAndUpsertOne } from "./research-models-runner.ts";

const ok: SmokeTestResult = { presetName: "", thinkingLevel: null, ok: true };
const never = new Promise<SmokeTestResult>(() => {});

const piResult: ModelResearchResult = {
  contextSize: 1000,
  samplingPresets: [],
  prices: [],
  description: null,
  source: null,
  supportsImage: false,
  reasoning: false,
  thinkingLevelMap: null,
};

// One subscriber for the whole file: an idle subscription can't be closed
// from outside (return() waits for its pending next), so tests share it.
const events: ModelResearchUpdatePayload[] = [];
void (async () => {
  for await (const e of pubsub.subscribe("modelResearchUpdated")) {
    events.push(e);
  }
})();

let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  spies = [
    spyOn(docsScraper, "scrapePricing").mockResolvedValue(new Map()),
    spyOn(docsScraper, "scrapeModelCapabilities").mockResolvedValue(new Map()),
    spyOn(researchModels, "smokeTestPresets").mockResolvedValue([]),
  ];
  events.length = 0;
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

async function statusesWithin(ms: number) {
  await Bun.sleep(ms);
  return events.map((e) => e.status);
}

describe("researchAndUpsertOne", () => {
  test("publishes 'failed' as soon as pi research rejects, with the window probes still running", async () => {
    spies.push(
      spyOn(researchModels, "probeWindows").mockReturnValue({
        asap: never,
        balanced: never,
        flex: never,
      }),
      spyOn(researchModels, "runPiResearch").mockRejectedValue(
        new Error("pi SDK error: 503 model_capacity_unavailable"),
      ),
    );

    await expect(researchAndUpsertOne("m-fail")).rejects.toThrow("503");
    expect(await statusesWithin(10)).toEqual(["started", "failed"]);
    expect(events[1]!.error).toContain("model_capacity_unavailable");
  });

  test("publishes 'completed' once asap is confirmed, and saves the windows when the flex probe answers", async () => {
    let answerFlex!: (r: SmokeTestResult) => void;
    const probes: WindowProbes = {
      asap: Promise.resolve(ok),
      balanced: Promise.resolve({ ...ok, ok: false, error: "unsupported" }),
      flex: new Promise((r) => (answerFlex = r)),
    };
    const upsert = spyOn(researchModels, "upsertModelMeta").mockResolvedValue();
    const save = spyOn(
      researchModels,
      "saveSupportedWindows",
    ).mockResolvedValue();
    spies.push(
      upsert,
      save,
      spyOn(researchModels, "probeWindows").mockReturnValue(probes),
      spyOn(researchModels, "runPiResearch").mockResolvedValue({
        ...piResult,
      }),
    );

    await researchAndUpsertOne("m-ok");
    expect(await statusesWithin(10)).toEqual(["started", "completed"]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();

    answerFlex(ok);
    await Bun.sleep(10);
    expect(save).toHaveBeenCalledWith("m-ok", new Set(["asap", "flex"]));
  });
});
