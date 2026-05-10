// Default fallback for local development — Docker builds overwrite this file
// with the actual git commit hash via `RUN echo ... > src/build-info.ts`.
export const GIT_COMMIT = process.env.GIT_COMMIT ?? "dev";
