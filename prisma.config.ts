import { defineConfig } from "prisma/config";

// Prisma 7 reads the connection URL from here, not from schema.prisma. Bun
// loads .env itself. process.env rather than prisma's env(), which throws when
// the variable is unset: the Docker build runs `prisma generate` without one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
