# -- build stage --
FROM oven/bun:1 AS build
ARG GIT_COMMIT=unknown
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate

COPY . .

# Bake the git commit hash into a file the app can read at runtime
RUN echo "export const GIT_COMMIT = \"${GIT_COMMIT}\";" > /app/src/build-info.ts

# Install frontend dependencies and build
WORKDIR /app/frontend
RUN bun install --frozen-lockfile
RUN bun run build

# -- runtime stage --
FROM oven/bun:1
ARG GIT_COMMIT=unknown
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/shared ./shared
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/entrypoint.sh ./

RUN chmod +x entrypoint.sh

ENV DATABASE_URL=file:/app/data/proxy.db
ENV LOG_DIR=/app/data/logs
ENV GIT_COMMIT=${GIT_COMMIT}
VOLUME /app/data
EXPOSE 4000

CMD ["./entrypoint.sh"]
