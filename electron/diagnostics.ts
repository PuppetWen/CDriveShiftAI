import { app } from "electron";
import { constants as fsConstants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppUpdateInfo } from "./update";
import type { AppSettings, IndexerStatus, MigrationRecord } from "./types";

const LOG_TAIL_BYTES = 256 * 1024;
const MAX_LOG_FILES = 4;

function sanitizedEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 2_048);
  }
}

async function pathProbe(candidate: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { path: candidate };
  for (const [name, mode] of [
    ["readable", fsConstants.R_OK],
    ["writable", fsConstants.W_OK],
    ["executable", fsConstants.X_OK]
  ] as const) {
    try {
      await access(candidate, mode);
      result[name] = true;
    } catch (error) {
      const detail = error as NodeJS.ErrnoException;
      result[name] = false;
      result[`${name}Error`] = detail.code ?? detail.message;
    }
  }
  try {
    const details = await stat(candidate);
    result.exists = true;
    result.size = details.size;
    result.modifiedAt = details.mtime.toISOString();
  } catch (error) {
    result.exists = false;
    result.statError = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  return result;
}

async function tailFile(candidate: string): Promise<string> {
  const details = await stat(candidate);
  const length = Math.min(details.size, LOG_TAIL_BYTES);
  const handle = await open(candidate, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, details.size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function recentLogs(logDirectory: string): Promise<Array<Record<string, unknown>>> {
  try {
    const entries = await readdir(logDirectory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(?:jsonl|log)(?:\.\d+)?$/i.test(entry.name))
        .map(async (entry) => {
          const candidate = path.join(logDirectory, entry.name);
          return { name: entry.name, candidate, details: await stat(candidate) };
        })
    );
    candidates.sort((left, right) => right.details.mtimeMs - left.details.mtimeMs);
    return Promise.all(
      candidates.slice(0, MAX_LOG_FILES).map(async ({ name, candidate, details }) => ({
        name,
        size: details.size,
        modifiedAt: details.mtime.toISOString(),
        tail: await tailFile(candidate)
      }))
    );
  } catch (error) {
    return [{ error: (error as NodeJS.ErrnoException).code ?? String(error) }];
  }
}

async function crashDumpMetadata(crashDirectory: string): Promise<Array<Record<string, unknown>>> {
  try {
    const entries = await readdir(crashDirectory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .slice(-20)
        .map(async (entry) => {
          const details = await stat(path.join(crashDirectory, entry.name));
          return {
            name: entry.name,
            size: details.size,
            modifiedAt: details.mtime.toISOString()
          };
        })
    );
    return files.sort((left, right) =>
      String(right.modifiedAt).localeCompare(String(left.modifiedAt))
    );
  } catch {
    return [];
  }
}

export interface DiagnosticInput {
  applicationDataRoot: string;
  logDirectory: string;
  settings: AppSettings;
  update?: AppUpdateInfo;
  indexer?: IndexerStatus;
  migrations: MigrationRecord[];
}

export async function createDiagnosticReport(input: DiagnosticInput): Promise<string> {
  const helperPath = path.join(process.resourcesPath, "bin", "cshift-updater.exe");
  const crashDirectory = app.getPath("crashDumps");
  const migrationStages = Object.fromEntries(
    [...new Set(input.migrations.map((record) => record.stage))].map((stage) => [
      stage,
      input.migrations.filter((record) => record.stage === stage).length
    ])
  );
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacy: {
      apiKeysIncluded: false,
      searchQueriesIncluded: false,
      fileContentsIncluded: false,
      note: "日志可能包含发生故障的程序路径；发送前可自行查看。"
    },
    application: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      pid: process.pid,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      dataRoot: input.applicationDataRoot,
      locale: app.getLocale(),
      distribution: process.env.PORTABLE_EXECUTABLE_FILE ? "portable" : app.isPackaged ? "installed" : "development"
    },
    operatingSystem: {
      platform: os.platform(),
      release: os.release(),
      version: os.version(),
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    settings: {
      effectMode: input.settings.effectMode,
      launchAtLogin: input.settings.launchAtLogin,
      minimizeToTray: input.settings.minimizeToTray,
      globalShortcutConfigured: Boolean(input.settings.globalShortcut),
      quickSearchShortcutConfigured: Boolean(input.settings.quickSearchShortcut),
      mouseQuickSearchButton: input.settings.mouseQuickSearchButton,
      mouseQuickSearchHoldMs: input.settings.mouseQuickSearchHoldMs,
      ai: {
        enabled: input.settings.ai.enabled,
        provider: input.settings.ai.provider,
        protocol: input.settings.ai.protocol,
        baseUrl: sanitizedEndpoint(input.settings.ai.baseUrl),
        model: input.settings.ai.model,
        hasApiKey: input.settings.ai.hasApiKey,
        privacyMode: input.settings.ai.privacyMode
      }
    },
    update: input.update,
    indexer: input.indexer,
    migrations: {
      total: input.migrations.length,
      stages: migrationStages
    },
    pathChecks: await Promise.all([
      pathProbe(input.applicationDataRoot),
      pathProbe(input.logDirectory),
      pathProbe(process.execPath),
      pathProbe(helperPath)
    ]),
    crashDumps: await crashDumpMetadata(crashDirectory),
    logs: await recentLogs(input.logDirectory)
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
