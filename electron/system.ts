import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriveInfo } from "./types";

const execFileAsync = promisify(execFile);
const DRIVE_DISCOVERY_TTL_MS = 30_000;

interface LocalDriveMetadata {
  root: string;
  fileSystem: string;
}

let driveDiscoveryCache:
  | { expiresAt: number; promise: Promise<LocalDriveMetadata[]> }
  | undefined;
let elevationCheck: Promise<boolean> | undefined;

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
  ...programFilesPaths.map((root) => path.join(root, "WindowsApps")),
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
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative));
}

export function protectedReason(candidate: string): string | undefined {
  if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(candidate)) return "不支持设备命名空间路径，请选择普通本地路径";
  const normalized = normalizeWindowsPath(candidate);
  if (/^[a-z]:\\(?:WindowsApps|WpSystem)(?:\\|$)/i.test(normalized)) return "Windows 商店应用由系统管理，不能直接迁移或删除";
  if (/\\AppData\\Local\\Packages(?:\\|$)/i.test(normalized)) return "Windows 商店应用数据由应用容器管理，不能直接迁移或删除";
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

async function discoverLocalDrives(): Promise<LocalDriveMetadata[]> {
  const now = Date.now();
  if (driveDiscoveryCache && driveDiscoveryCache.expiresAt > now) {
    return driveDiscoveryCache.promise;
  }
  const promise = (async () => {
    try {
      const script =
        "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | " +
        "Select-Object DeviceID,FileSystem) | ConvertTo-Json -Compress";
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024 }
      );
      const parsed = JSON.parse(stdout.trim()) as
        | { DeviceID?: unknown; FileSystem?: unknown }
        | Array<{ DeviceID?: unknown; FileSystem?: unknown }>;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const drives = values
        .filter(
          (item): item is { DeviceID: string; FileSystem?: unknown } =>
            typeof item?.DeviceID === "string" && /^[A-Z]:$/i.test(item.DeviceID)
        )
        .map((item) => ({
          root: `${item.DeviceID.toUpperCase()}\\`,
          fileSystem:
            typeof item.FileSystem === "string" && item.FileSystem.trim()
              ? item.FileSystem.trim()
              : "Unknown"
        }));
      return drives.length ? drives : [{ root: "C:\\", fileSystem: "Unknown" }];
    } catch {
      return [{ root: "C:\\", fileSystem: "Unknown" }];
    }
  })();
  driveDiscoveryCache = {
    expiresAt: now + DRIVE_DISCOVERY_TTL_MS,
    promise
  };
  return promise;
}

export async function getDriveInfo(root = "C:\\"): Promise<DriveInfo> {
  const [stats, drives] = await Promise.all([statfs(root), discoverLocalDrives()]);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const normalizedRoot = `${root.slice(0, 1).toUpperCase()}:\\`;
  const fileSystem =
    drives.find((drive) => drive.root.toUpperCase() === normalizedRoot)?.fileSystem ??
    "Unknown";
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
  return (await discoverLocalDrives()).map((drive) => drive.root);
}

export async function isElevated(): Promise<boolean> {
  elevationCheck ??= (async () => {
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
      ], {
        windowsHide: true,
        timeout: 3_000
      });
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  })();
  return elevationCheck;
}

export function systemIdentity() {
  return {
    hostname: os.hostname(),
    platform: process.platform
  };
}
