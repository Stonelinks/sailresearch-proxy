import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "./generated/prisma/client.ts";

// Prisma 7 talks to SQLite through a driver adapter. libsql rather than
// better-sqlite3 because Bun does not load better-sqlite3's native module.
// unixepoch-ms keeps DateTime columns in the integer milliseconds the Prisma 6
// engine wrote; the adapter default (ISO text) would mix types in one column,
// and SQLite orders every integer before any text.
export const prisma = new PrismaClient({
  adapter: new PrismaLibSql(
    { url: process.env.DATABASE_URL! },
    { timestampFormat: "unixepoch-ms" },
  ),
});
