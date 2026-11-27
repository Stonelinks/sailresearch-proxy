#!/bin/sh
set -e

# Apply committed migrations (SQLite auto-creates the file)
bunx prisma migrate deploy

exec bun run src/index.ts
