#!/bin/sh
set -e

# Apply committed migrations (SQLite auto-creates the file)
bunx prisma migrate deploy
bunx prisma generate

exec bun run src/index.ts
