import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const REDACTED_KEYS = /(?:api[-_]?key|authorization|token|secret|password|query|content|preview)/i;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

let logDirectory = "";
let currentPath = "";
let currentBytes = 0;

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (REDACTED_KEYS.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return value.slice(0, 16_384);
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitize(entryValue, entryKey, depth + 1)
        ])
    );
  }
  return String(value).slice(0, 2_048);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const details = error as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    path?: unknown;
    spawnargs?: unknown;
    cause?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: details.code,
    errno: details.errno,
    syscall: details.syscall,
    path: details.path,
    spawnargs: details.spawnargs,
    cause: details.cause instanceof Error ? serializeError(details.cause) : details.cause
  };
}

function pruneOldLogs(): void {
  const cutoff = Date.now() - MAX_LOG_AGE_MS;
  try {
    for (const entry of readdirSync(logDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^main-.*\.jsonl(?:\.\d+)?$/.test(entry.name)) continue;
      const candidate = path.join(logDirectory, entry.name);
      if (statSync(candidate).mtimeMs < cutoff) unlinkSync(candidate);
    }
  } catch {
    // Logging must never prevent the application from starting.
  }
}

function resolveCurrentPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDirectory, `main-${date}.jsonl`);
}

function rotateIfNeeded(nextBytes: number): void {
  const expected = resolveCurrentPath();
  if (currentPath !== expected) {
    currentPath = expected;
    currentBytes = existsSync(currentPath) ? statSync(currentPath).size : 0;
  }
  if (currentBytes + nextBytes <= MAX_LOG_BYTES) return;
  try {
    for (let index = 3; index >= 1; index -= 1) {
      const source = index === 1 ? currentPath : `${currentPath}.${index - 1}`;
      const destination = `${currentPath}.${index}`;
      if (existsSync(source)) {
        if (existsSync(destination)) unlinkSync(destination);
        renameSync(source, destination);
      }
    }
  } catch {
    // If rotation loses a race, append to the existing file instead.
  }
  currentBytes = existsSync(currentPath) ? statSync(currentPath).size : 0;
}

export function configureLogger(applicationDataRoot: string): string {
  logDirectory = path.join(applicationDataRoot, "logs");
  mkdirSync(logDirectory, { recursive: true });
  currentPath = resolveCurrentPath();
  currentBytes = existsSync(currentPath) ? statSync(currentPath).size : 0;
  pruneOldLogs();
  return logDirectory;
}

export function getLogDirectory(): string {
  return logDirectory;
}

export function writeLog(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (!logDirectory) return;
  try {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event: event.slice(0, 160),
      pid: process.pid,
      fields: sanitize(fields)
    })}\n`;
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    appendFileSync(currentPath, line, { encoding: "utf8", mode: 0o600 });
    currentBytes += bytes;
  } catch {
    // Error reporting must never become a second application failure.
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => writeLog("debug", event, fields),
  info: (event: string, fields?: LogFields) => writeLog("info", event, fields),
  warn: (event: string, fields?: LogFields) => writeLog("warn", event, fields),
  error: (event: string, fields?: LogFields) => writeLog("error", event, fields)
};
