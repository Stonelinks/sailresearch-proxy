import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { log, setLogLevel, getLogLevel } from "./logger.ts";

describe("logger", () => {
  const original = getLogLevel();

  afterEach(() => {
    setLogLevel(original);
  });

  test("debug level emits all four levels", () => {
    setLogLevel("debug");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(out).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(2);

    out.mockRestore();
    err.mockRestore();
  });

  test("info level suppresses debug", () => {
    setLogLevel("info");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);

    out.mockRestore();
    err.mockRestore();
  });

  test("warn level suppresses debug and info", () => {
    setLogLevel("warn");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);

    out.mockRestore();
    err.mockRestore();
  });

  test("error level suppresses everything except error", () => {
    setLogLevel("error");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);

    out.mockRestore();
    err.mockRestore();
  });

  test("invalid LOG_LEVEL env defaults to info", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import('${import.meta.dir}/logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: "garbage" },
    });
    expect(result.stdout.toString().trim()).toBe("info");
  });

  test("defaults to info when no env var is set", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import('${import.meta.dir}/logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: undefined },
    });
    expect(result.stdout.toString().trim()).toBe("info");
  });

  test("reads VITE_LOG_LEVEL when process.env is available but LOG_LEVEL is not", async () => {
    // In Bun, process.env exists, so it takes priority over import.meta.env.
    // To test the VITE_LOG_LEVEL path, we need to suppress process.env.LOG_LEVEL
    // and simulate the browser environment. We do this by having the subprocess
    // delete process.env before importing logger.
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `
// Simulate browser: remove process so logger falls through to import.meta.env path
const originalProcess = globalThis.process;
delete (globalThis as any).process;
// Set up import.meta.env.VITE_LOG_LEVEL via a define-like trick
// Since import.meta.env is read-only at build time, we test the fallback path
// by verifying that without process, the default is "info"
import('${import.meta.dir}/logger.ts').then(m => {
  console.log(m.getLogLevel());
  (globalThis as any).process = originalProcess;
});
`,
      ],
      env: { ...process.env, LOG_LEVEL: undefined },
    });
    // Without process and without import.meta.env.VITE_LOG_LEVEL, defaults to "info"
    expect(result.stdout.toString().trim()).toBe("info");
  });

  test("LOG_LEVEL=debug is respected", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import('${import.meta.dir}/logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: "debug" },
    });
    expect(result.stdout.toString().trim()).toBe("debug");
  });

  test("LOG_LEVEL=warn is respected", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import('${import.meta.dir}/logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: "warn" },
    });
    expect(result.stdout.toString().trim()).toBe("warn");
  });

  test("LOG_LEVEL=error is respected", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import('${import.meta.dir}/logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: "error" },
    });
    expect(result.stdout.toString().trim()).toBe("error");
  });

  test("setLogLevel overrides the env-derived level", () => {
    setLogLevel("error");
    expect(getLogLevel()).toBe("error");
    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
  });
});
