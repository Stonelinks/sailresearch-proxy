import { afterAll, beforeEach, expect, test } from "bun:test";
import { config } from "./config.ts";
import { runPiPrompt } from "./pi-session.ts";

// One fake upstream for the file: pi-session reads config when it first
// builds its model runtime, and keeps that runtime.
let handle: (model: string) => Response;
const seen: string[] = [];
const srv = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const { model } = (await req.json()) as { model: string };
    seen.push(model);
    return handle(model);
  },
});
config.server.port = srv.port!;
config.research.models = ["first/model", "second/model"];

beforeEach(() => {
  seen.length = 0;
});
afterAll(() => srv.stop(true));

const capacity = () =>
  Response.json(
    {
      error: {
        message:
          "This model is temporarily unavailable. Please retry with backoff.",
        type: "model_capacity_unavailable",
        code: "model_capacity_unavailable",
      },
    },
    { status: 503 },
  );

function sse(text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: text }, null) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("runPiPrompt rejects with a pi SDK error instead of returning empty text", async () => {
  handle = () =>
    Response.json(
      { error: { message: "model exploded", type: "server_error" } },
      { status: 500 },
    );
  await expect(runPiPrompt("hi")).rejects.toThrow(/^pi SDK error: \S/);
  // Not a capacity error, so the second model is never tried.
  expect(seen).not.toContain("second/model");
}, 60_000);

test("runPiPrompt falls back to the next model when one is out of capacity", async () => {
  handle = (model) => (model === "first/model" ? capacity() : sse('{"ok":1}'));
  expect(await runPiPrompt("hi")).toBe('{"ok":1}');
  expect(seen.at(-1)).toBe("second/model");
}, 60_000);

test("runPiPrompt throws the capacity error when every model is out", async () => {
  handle = capacity;
  await expect(runPiPrompt("hi")).rejects.toThrow(/model_capacity_unavailable/);
  expect(new Set(seen)).toEqual(new Set(["first/model", "second/model"]));
}, 60_000);
