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

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

HTML files can import `.tsx`, `.jsx`, or `.js` files directly and Bun's bundler will transpile and bundle. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
