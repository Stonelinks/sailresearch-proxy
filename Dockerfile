# -- build stage --
# Pinned: bump deliberately; a floating tag let rebuilds change Bun with no commit.
FROM oven/bun:1.4.5 AS build
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

# -- test stage --
# The deploy gate: cricket's CI builds this image and nothing else, and the
# runtime stage below copies a marker out of this one, so the build cannot
# reach a runnable image unless the suites pass. Same commands as bin/test
# and bin/test-frontend.
FROM build AS test
WORKDIR /app
# One bun process per file: mock.module() in one test file leaks into files
# that run after it in the same process, and `find` order differs by
# filesystem, so a single `bun test` run passed on a laptop and failed here.
RUN for f in $(find src shared -name "*.test.ts" -type f | sort); do \
      SAIL_API_KEY=test bun test "$f" || exit 1; \
    done
RUN cd frontend && bun run test
RUN touch /tests-passed

# -- runtime stage --
FROM oven/bun:1.4.5
ARG GIT_COMMIT=unknown
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/shared ./shared
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/entrypoint.sh ./
# Forces the test stage to run; BuildKit skips stages nothing depends on.
COPY --from=test /tests-passed /tmp/tests-passed

RUN chmod +x entrypoint.sh

ENV DATABASE_URL=file:/app/data/proxy.db
ENV LOG_DIR=/app/data/logs
ENV GIT_COMMIT=${GIT_COMMIT}
VOLUME /app/data
EXPOSE 4000

CMD ["./entrypoint.sh"]
