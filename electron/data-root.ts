import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DATA_DIRECTORY_NAME = ".cdriveshiftai-data";

function isWorkspaceRoot(candidate: string): boolean {
  const manifestPath = path.join(candidate, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
    return manifest.name?.toLocaleLowerCase() === "cdriveshiftai";
  } catch {
    return false;
  }
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (let depth = 0; depth < 4; depth += 1) {
    if (isWorkspaceRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function resolveApplicationDataRoot(): string {
  const override = process.env.CDRIVESHIFTAI_DATA_DIR?.trim();
  if (override) return path.resolve(override);

  if (!app.isPackaged) {
    return path.resolve(__dirname, "..", DATA_DIRECTORY_NAME);
  }

  const executableDirectory =
    process.env.PORTABLE_EXECUTABLE_DIR?.trim() || path.dirname(app.getPath("exe"));
  const workspaceRoot = findWorkspaceRoot(executableDirectory);
  return path.join(workspaceRoot ?? executableDirectory, DATA_DIRECTORY_NAME);
}

export function configureApplicationDataPaths(): string {
  const root = resolveApplicationDataRoot();
  const sessionData = path.join(root, "session-data");
  const logs = path.join(root, "logs");
  const crashDumps = path.join(root, "crash-dumps");
  const temporary = path.join(root, "temp");

  for (const directory of [root, sessionData, logs, crashDumps, temporary]) {
    mkdirSync(directory, { recursive: true });
  }

  app.setPath("userData", root);
  app.setPath("sessionData", sessionData);
  app.setPath("crashDumps", crashDumps);
  app.setPath("temp", temporary);
  app.setAppLogsPath(logs);
  return root;
}
