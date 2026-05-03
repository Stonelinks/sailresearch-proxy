# Project Rules

All AI agents working on this project must follow these rules.

## Completion Gate

Before considering any work complete, run `bin/check` and ensure it passes with no errors. This runs formatting, typechecking, and tests. Do not submit or mark work done if `bin/check` fails.

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

- WebSocket endpoint at `/ws/dashboard` for live job updates
- Poller broadcasts job status changes to all connected WS clients
- Frontend `connectJobUpdates()` in `api.ts` handles auto-reconnection

### Conventions

- Svelte 5 with runes (`$state`, `$derived`, `$props`)
- Tailwind v4 with `@theme` for font tokens
- Components in `frontend/src/components/`, pages in `frontend/src/pages/`
- API helpers in `frontend/src/api.ts`
