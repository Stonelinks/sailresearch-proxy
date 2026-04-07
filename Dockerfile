# -- build stage --
FROM oven/bun:latest AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate

COPY . .

# -- runtime stage --
FROM oven/bun:latest
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./

ENV DATABASE_URL=file:/app/data/proxy.db
VOLUME /app/data
EXPOSE 4000

CMD ["bun", "run", "src/index.ts"]
