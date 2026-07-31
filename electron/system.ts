import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriveInfo } from "./types";

const execFileAsync = promisify(execFile);

const windowsRoot = process.env.SystemRoot || "C:\\Windows";
const systemDrive = path.parse(windowsRoot).root || "C:\\";
const programFilesPaths = [
  process.env.ProgramFiles,
  process.env["ProgramFiles(x86)"],
  path.join(systemDrive, "Program Files"),
  path.join(systemDrive, "Program Files (x86)")
].filter((value): value is string => Boolean(value));

export const CORE_PROTECTED_PATHS = [
  windowsRoot,
  path.join(systemDrive, "ProgramData", "Microsoft"),
  path.join(systemDrive, "Users", "Default"),
  path.join(systemDrive, "Users", "Public"),
  path.join(systemDrive, "System Volume Information"),
  path.join(systemDrive, "$Recycle.Bin")
];

export const PROTECTED_PATHS = [...new Set([...CORE_PROTECTED_PATHS, ...programFilesPaths])];

export function normalizeWindowsPath(input: string): string {
  const resolved = path.win32.resolve(input.trim());
  return resolved.replace(/[\\/]+$/, resolved.length === 3 ? "\\" : "");
}

export function samePath(a: string, b: string): boolean {
  return normalizeWindowsPath(a).toLocaleLowerCase() === normalizeWindowsPath(b).toLocaleLowerCase();
}

export function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.win32.relative(normalizeWindowsPath(parent), normalizeWindowsPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

export function protectedReason(candidate: string): string | undefined {
  const normalized = normalizeWindowsPath(candidate);
  if (/^[a-zA-Z]:\\$/.test(normalized)) return "不能迁移整个盘符根目录";
  const exactOrParent = CORE_PROTECTED_PATHS.find(
    (protectedPath) =>
      samePath(normalized, protectedPath) || isPathWithin(protectedPath, normalized)
  );
  if (exactOrParent) return `该目录包含受保护的系统路径：${exactOrParent}`;
  const insideProtected = CORE_PROTECTED_PATHS.find((protectedPath) =>
    isPathWithin(normalized, protectedPath)
  );
  if (insideProtected) return `该目录位于受保护的系统路径内：${insideProtected}`;
  const programContainer = programFilesPaths.find(
    (programPath) => samePath(normalized, programPath) || isPathWithin(programPath, normalized)
  );
  if (programContainer) return `不能迁移整个应用安装容器：${programContainer}`;
  return undefined;
}

export function isHighRiskApplicationPath(candidate: string): boolean {
  return programFilesPaths.some((programPath) => isPathWithin(candidate, programPath));
}

export async function getDriveInfo(root = "C:\\"): Promise<DriveInfo> {
  const stats = await statfs(root);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  let fileSystem = "Unknown";
  try {
    const driveLetter = root.slice(0, 1);
    const script = `(Get-Volume -DriveLetter '${driveLetter}' -ErrorAction Stop).FileSystem`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 5_000 }
    );
    fileSystem = stdout.trim() || fileSystem;
  } catch {
    // statfs is still enough for capacity information.
  }
  return {
    name: root.toUpperCase().startsWith("C:") ? "System" : `Drive ${root.slice(0, 1).toUpperCase()}`,
    root,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    fileSystem
  };
}

export async function getLocalDriveRoots(): Promise<string[]> {
  try {
    const script =
      "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | " +
      "Select-Object -ExpandProperty DeviceID) | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 8_000 }
    );
    const parsed = JSON.parse(stdout.trim()) as string | string[];
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const roots = values
      .filter((value): value is string => typeof value === "string" && /^[A-Z]:$/i.test(value))
      .map((value) => `${value.toUpperCase()}\\`);
    return roots.length ? roots : ["C:\\"];
  } catch {
    return ["C:\\"];
  }
}

export async function isElevated(): Promise<boolean> {
  try {
    await execFileAsync("net.exe", ["session"], {
      windowsHide: true,
      timeout: 3_000
    });
    return true;
  } catch {
    return false;
  }
}

export function systemIdentity() {
  return {
    hostname: os.hostname(),
    platform: process.platform
  };
}
