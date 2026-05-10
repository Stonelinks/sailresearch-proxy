import { describe, test, expect } from "bun:test";
import { handleVersion } from "./version.ts";

describe("handleVersion", () => {
  test("returns JSON with version and commit fields", async () => {
    const res = handleVersion(new Request("http://x/api/version"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("commit");
    expect(typeof body.version).toBe("string");
    expect(typeof body.commit).toBe("string");
    // version should match what's in package.json
    expect(body.version).toBe("0.1.0");
  });
});
