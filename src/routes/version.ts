import { GIT_COMMIT } from "../build-info.ts";

// Read version from package.json at startup
let version = "unknown";
try {
  const pkgUrl = new URL("../../package.json", import.meta.url);
  const text = await Bun.file(pkgUrl).text();
  version = JSON.parse(text).version ?? "unknown";
} catch {
  // package.json not found (unlikely but defensive)
}

/**
 * GET /api/version — returns the app version and git commit hash.
 */
export function handleVersion(_req: Request): Response {
  return Response.json({ version, commit: GIT_COMMIT });
}
