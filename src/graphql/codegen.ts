/**
 * Write the GraphQL schema to shared/schema.graphql so the frontend codegen
 * (Houdini) can read it without spinning up the server. Run via
 * `bun run codegen:schema`. The committed file is the canonical contract;
 * CI fails if `git diff --exit-code shared/schema.graphql` shows drift.
 */
import { printSchema } from "graphql";
import { schema } from "./schema.ts";
import path from "node:path";

const out = path.resolve(import.meta.dir, "../../shared/schema.graphql");
const sdl = printSchema(schema) + "\n";
await Bun.write(out, sdl);
console.log(`[codegen] wrote ${out} (${sdl.length} bytes)`);
