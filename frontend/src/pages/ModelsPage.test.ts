import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

// Smoke test: mount the page with the real houdini client module, so a
// client construction error (e.g. an option houdini no longer accepts)
// fails here instead of when the page loads in a browser.

const FAKE_MODEL = {
  id: "acme/smoke-model-1",
  object: "model",
  created: 0,
  ownedBy: "acme",
  contextSize: 128000,
  description: "fake",
  source: "test",
  supportsImage: false,
  reasoning: false,
  thinkingLevelMap: null,
  supportedWindows: [],
  researchedAt: null,
  samplingPresets: [],
  prices: [],
};

beforeEach(() => {
  // The subscription plugin opens a graphql-ws socket; keep it inert.
  vi.stubGlobal(
    "WebSocket",
    class {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const { query } = JSON.parse(String(init?.body ?? "{}"));
      const data = /query ModelsList/.test(query)
        ? { models: [FAKE_MODEL] }
        : { activeResearch: { modelIds: [], batch: null } };
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("ModelsPage renders a model fetched through the houdini client", async () => {
  const { default: ModelsPage } = await import("./ModelsPage.svelte");
  const component = mount(ModelsPage, { target: document.body });
  await vi.waitFor(() => expect(document.body.textContent).toContain("smoke-model-1"));
  unmount(component);
});
