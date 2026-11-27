import { expect, test } from "bun:test";

test("runPiPrompt rejects with a pi SDK error instead of returning empty text", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: "model exploded", type: "server_error" } },
        { status: 500 },
      ),
  });
  // config reads PORT at import time, so set it before the dynamic import.
  process.env.PORT = String(srv.port);
  process.env.SAIL_API_KEY ??= "test";
  try {
    const { runPiPrompt } = await import("./pi-session.ts");
    await expect(runPiPrompt("hi")).rejects.toThrow(/^pi SDK error: \S/);
  } finally {
    srv.stop(true);
  }
}, 60_000);
