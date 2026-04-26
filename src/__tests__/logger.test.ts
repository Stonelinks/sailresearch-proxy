import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { log, setLogLevel, getLogLevel } from "../logger.ts";

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
        `import('${import.meta.dir}/../logger.ts').then(m => { console.log(m.getLogLevel()); });`,
      ],
      env: { ...process.env, LOG_LEVEL: "garbage" },
    });
    expect(result.stdout.toString().trim()).toBe("info");
  });
});
