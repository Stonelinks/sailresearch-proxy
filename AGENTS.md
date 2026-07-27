# Project Rules

All AI agents working on this project must follow these rules.

## Git Workflow

Commit directly to `main`. Do **not** create a feature branch for routine work, even though the
default Claude Code guidance is to branch off the default branch — this project overrides that.
Make small, focused commits straight on `main`. (Standard rules still apply: only commit/push
when the user asks, and keep each commit scoped to one logical change.)

## Slow Tests

Tests in this project are slow — they involve real HTTP servers, WebSocket connections, and database operations. **2× your normal timeout estimates** when running `bun test` or `bin/check`. A typical `bun test` run takes 30–60+ seconds, and `bin/check` even longer due to formatting and typechecking before tests. Plan accordingly and don't kill a test run prematurely thinking it's hung.

## Completion Gate

Before considering any work complete, run `bin/check` and ensure it passes with no errors. This runs formatting, typechecking, and tests. Do not submit or mark work done if `bin/check` fails. Allow ample time — `bin/check` is not a fast script.

## Use Bun

This project uses Bun. Do not use Node.js, npm, pnpm, yarn, vite, or their ecosystems.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't use `dotenv`.

### Bun APIs

- `Bun.serve()` for HTTP/WebSocket servers. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- `Bun.$` for shell commands instead of `execa`.

## Running a Live Copy

The host typically has a long-running proxy already listening on the default port (4000), and the dev Vite server on 5173. **Do not start your own copy on those ports** — you'll either fail to bind or knock the user's instance offline.

When you need to run the proxy yourself (manual testing, reproducing a bug against a live Sail backend, etc.), override `PORT` to a free port in the 4100–4999 range:

```bash
PORT=4100 bin/run
```

Avoid `bin/dev` unless you also override Vite's port (it hardcodes `vite --host` which defaults to 5173 and will collide). For most agent work, running just the backend on a non-default port is enough — hit `http://localhost:4100/health`, `http://localhost:4100/v1/...`, etc. directly.

Stop your copy when you're done — don't leave a stray process running. The integration test suite (`bun test`) already binds to a random port and a temp DB, so it doesn't conflict; prefer it over a manually-started server when you can.

## Database Schema Changes

Use real Prisma migrations, not `db push`, whenever you change `prisma/schema.prisma`.

`db push` syncs the schema directly and discards columns/tables without history. It's fine for throwaway exploration, but it leaves no trail and breaks deployed databases the moment a column is removed (it refuses without `--accept-data-loss`, which silently destroys data).

### Workflow

The migration history was squashed to a single baseline (`20260726120000_thin_proxy_baseline`) when the batching machinery (and its `PendingJob` table) was removed — an earlier misdated migration folder broke shadow-DB replay for both `migrate dev` and fresh-DB `migrate deploy`. Databases provisioned before the squash need a one-time `bunx prisma migrate resolve --applied 20260726120000_thin_proxy_baseline` (and, for `migrate dev` to work, deletion of the pre-squash rows from `_prisma_migrations`). To change the schema:

1. Edit `prisma/schema.prisma`.
2. Generate and apply a migration locally:

   ```bash
   bunx prisma migrate dev --name <short_description>
   ```

   This creates a new directory under `prisma/migrations/` containing the SQL, applies it to your local SQLite DB, and regenerates the Prisma client. **Commit the generated migration directory along with the schema change.**

3. For destructive changes (dropping a column, narrowing a type), write a custom migration that preserves data when possible — e.g. backfill a new column before dropping the old one across two migrations.

If `migrate dev` fails with a drift error (e.g. because `db push` was used previously), do **not** use `db push` or `--accept-data-loss`. Instead:

1. Back up the data: `cp data/proxy.db data/proxy.db.bak`
2. Dump just the data: `sqlite3 data/proxy.db "$(sqlite3 data/proxy.db .dump)" | grep '^INSERT' > /tmp/proxy_inserts.sql` — or more reliably: `sqlite3 data/proxy.db .dump | grep '^INSERT' > /tmp/proxy_inserts.sql`
3. Delete the DB: `rm data/proxy.db`
4. Apply migrations fresh: `bunx prisma migrate deploy`
5. Restore data: `sqlite3 data/proxy.db < /tmp/proxy_inserts.sql`
6. Verify counts match the backup.
7. Clean up: `rm data/proxy.db.bak /tmp/proxy_inserts.sql`

### Deployment

Production startup should run `bunx prisma migrate deploy` (apply committed migrations only, no schema diffing). Migrations are append-only — never edit a migration that has been applied to any environment; add a new one instead.

### Don't

- Don't run `prisma db push` against a database that has migrations applied — it bypasses the migration history and the next `migrate deploy` will fail.
- Don't pass `--accept-data-loss` to silence a `db push` warning. That's the signal to write a migration instead.
- Don't hand-edit `prisma/migrations/` after the migration has been committed/applied.

## Logging

All logs go to both the console and a file. The file logger is initialized at startup in `src/index.ts`.

- **Log file:** `$LOG_DIR/proxy.log` (default `data/logs/proxy.log`)
- **Format (file):** `2026-05-07 21:39:58.218 [INFO] message` — human-readable with timestamps
- **Format (console):** plain text, no timestamps (unchanged from before)
- **Rotation:** files rotate at 100 MB (`proxy.log` → `proxy.log.1` → …), oldest deleted after 30 files (~3 GB cap)
- **Config:** `LOG_DIR` env var (set in `env.sh` and `Dockerfile`), `LOG_LEVEL` controls verbosity

### Debugging with logs

When debugging a live copy on a custom port, tail the log file:

```bash
LOG_DIR=data/logs PORT=4100 bin/run   # in one terminal
tail -f data/logs/proxy.log             # in another
```

The file captures everything the console does (at the current `LOG_LEVEL`), plus timestamps. Set `LOG_LEVEL=debug` to see request/response details from the Sail client.

When running tests, logs go only to the console (file logging is not initialized in the test harness). Check `shared/logger.ts` for the `initFileLogging` / `closeFileLogging` API if you need file logging in a test.

## Frontend

The frontend is a Svelte SPA in `frontend/` built with Vite + Tailwind. `svelte-spa-router` handles routing.

### Development

- Run `bun dev` in the `frontend/` directory to start the Vite dev server on :5173 (proxies `/api/*` and `/ws/*` to the backend on :4000)
- Run `bin/dev` to start Vite dev server + Bun backend concurrently
- Use both together for hot-reloading frontend + backend

### Building

- `cd frontend && bun run build` outputs to `frontend/dist/`
- The Bun backend serves `frontend/dist/` as static files with SPA fallback
- `setup`, `dev`, and `run` scripts automatically build the frontend

### Real-time Updates

- GraphQL subscriptions over WebSocket at `/graphql` (graphql-ws)
- `modelResearchUpdated` streams research progress to the Models pages
- Houdini generates the typed client from `shared/schema.graphql` (`bun run codegen:client`)

### Conventions

- Svelte 5 with runes (`$state`, `$derived`, `$props`)
- Tailwind v4 with `@theme` for font tokens
- Components in `frontend/src/components/`, pages in `frontend/src/pages/`
- GraphQL documents live in the Svelte pages; Houdini artifacts in `frontend/$houdini`
