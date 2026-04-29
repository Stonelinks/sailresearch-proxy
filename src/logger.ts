type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLevel(raw: string | undefined): Level {
  const v = (raw || "info").toLowerCase();
  return v in ORDER ? (v as Level) : "info";
}

let currentLevel: Level = parseLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: Level) {
  currentLevel = level;
}

export function getLogLevel(): Level {
  return currentLevel;
}

function emit(level: Level, args: unknown[]) {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const sink =
    level === "error" || level === "warn" ? console.error : console.log;
  sink(...args);
}

export const log = {
  debug: (...a: unknown[]) => emit("debug", a),
  info: (...a: unknown[]) => emit("info", a),
  warn: (...a: unknown[]) => emit("warn", a),
  error: (...a: unknown[]) => emit("error", a),
};
