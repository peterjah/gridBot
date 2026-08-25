type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error"
    ? (raw as Level)
    : "info";
}

let threshold: number = LEVEL_ORDER[currentLevel()];

/** Change the active log level at runtime (mainly for tests). */
export function setLogLevel(level: Level): void {
  threshold = LEVEL_ORDER[level];
}

function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  // Logging must never throw — a BigInt or circular structure in a debug
  // field must not take down a live transaction path.
  let line: string;
  try {
    line = JSON.stringify(entry, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch (error) {
    line = JSON.stringify({
      ts: entry.ts as string,
      level,
      msg,
      serializeError: error instanceof Error ? error.message : String(error),
    });
  }
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
