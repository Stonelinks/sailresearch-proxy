#!/bin/sh
set -e

# Run prisma db push to ensure schema is up to date (SQLite auto-creates the file)
bunx prisma db push --skip-generate
bunx prisma generate

exec bun run src/index.ts
