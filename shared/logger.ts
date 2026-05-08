type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLevel(raw: string | undefined): Level {
  const v = (raw || "info").toLowerCase();
  return v in ORDER ? (v as Level) : "info";
}

/**
 * Detect the initial log level from the current environment.
 * - Bun / Node: reads `process.env.LOG_LEVEL`
 * - Vite browser: reads `import.meta.env.VITE_LOG_LEVEL`
 * - Fallback: `"info"`
 */
function readEnvLevel(): Level {
  // Bun / Node
  if (typeof process !== "undefined" && process.env) {
    return parseLevel(process.env.LOG_LEVEL);
  }
  // Vite browser build — import.meta.env is replaced at build time
  if (typeof import.meta !== "undefined" && (import.meta as any).env) {
    return parseLevel((import.meta as any).env.VITE_LOG_LEVEL);
  }
  return "info";
}

let currentLevel: Level = readEnvLevel();

export function setLogLevel(level: Level) {
  currentLevel = level;
}

export function getLogLevel(): Level {
  return currentLevel;
}

// --- File logging (winston) ---
//
// Winston is lazy-loaded so that the top-level `import winston` does not
// crash browser builds (winston depends on Node's `process` global at
// require-time).  File logging only makes sense on the server anyway.

import type { Logger } from "winston";

let fileLogger: Logger | null = null;

/** Lazy-load winston — returns null if the module is unavailable. */
function loadWinston(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("winston");
  } catch {
    return null;
  }
}

export interface FileLoggingOptions {
  /** Max size of a single log file before rotation (default 100 MB) */
  maxSize?: number;
  /** Max number of rotated files to keep (default 30 → ~3 GB at 100 MB each) */
  maxFiles?: number;
}

/**
 * Initialize file logging. All subsequent `log.*()` calls will also be
 * written to `logDir/proxy.log` with human-readable timestamps.
 * Rotation: when the file exceeds `maxSize` bytes it is renamed to
 * `proxy.log.1`, `proxy.log.2`, etc. When more than `maxFiles` rotated
 * files exist, the oldest is deleted.
 */
export function initFileLogging(
  logDir: string,
  options?: FileLoggingOptions,
): void {
  const w = loadWinston();
  if (!w) return;

  const maxSize = options?.maxSize ?? 100 * 1024 * 1024; // 100 MB
  const maxFiles = options?.maxFiles ?? 30; // ~3 GB total

  fileLogger = w.createLogger({
    level: "debug", // we filter by our own currentLevel in emit()
    format: w.format.combine(
      w.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      w.format.printf(({ timestamp, level, message }: any) => {
        return `${timestamp} [${level.toUpperCase()}] ${message}`;
      }),
    ),
    transports: [
      new w.transports.File({
        filename: `${logDir}/proxy.log`,
        maxsize: maxSize,
        maxFiles,
      }),
    ],
  });
}

/** Close the file logger (flush and release file handles). */
export function closeFileLogging(): void {
  if (fileLogger) {
    fileLogger.close();
    fileLogger = null;
  }
}

function emit(level: Level, args: unknown[]) {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const sink =
    level === "error" || level === "warn" ? console.error : console.log;
  sink(...args);

  // Mirror to file logger if initialized
  if (fileLogger) {
    const message = args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? a.stack ?? a.message
            : JSON.stringify(a),
      )
      .join(" ");
    fileLogger.log(level, message);
  }
}

export const log = {
  debug: (...a: unknown[]) => emit("debug", a),
  info: (...a: unknown[]) => emit("info", a),
  warn: (...a: unknown[]) => emit("warn", a),
  error: (...a: unknown[]) => emit("error", a),
};
