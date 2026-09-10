import { execFile } from "node:child_process";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FileLockProcess {
  pid: number;
  creationTime: string;
  protected: boolean;
}

export interface FileLockScan {
  processes: FileLockProcess[];
  warnings: string[];
}

export async function collectLockScanFiles(target: string, limit = 5_000): Promise<{ files: string[]; incomplete: boolean }> {
  const files: string[] = [];
  const pending = [target];
  let visited = 0;
  let incomplete = false;
  while (pending.length) {
    const entryPath = pending.pop()!;
    if (++visited > limit) return { files, incomplete: true };
    try {
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isFile()) files.push(entryPath);
      else if (stats.isDirectory()) {
        const directory = await opendir(entryPath);
        for await (const entry of directory) {
          if (pending.length + visited >= limit) {
            incomplete = true;
            break;
          }
          pending.push(path.join(entryPath, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
    }
  }
  return { files, incomplete };
}

// Only query resources. Do not use RmShutdown: termination must stay restricted
// to the identities shown in this application's confirmation dialog.
const RESTART_MANAGER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$files = [string[]](ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CShiftFileLocks {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int ApplicationType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public class LockProcess {
    public int pid;
    public string creationTime;
    public bool isProtected;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint count, string[] names, uint apps, IntPtr appList, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, out uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint session);
  public static LockProcess[] Query(string[] names) {
    uint session;
    int result = RmStartSession(out session, 0, new StringBuilder(33));
    if (result != 0) throw new Win32Exception(result);
    try {
      result = RmRegisterResources(session, (uint)names.Length, names, 0, IntPtr.Zero, 0, null);
      if (result != 0) throw new Win32Exception(result);
      uint count = 0, needed, reasons;
      ProcessInfo[] values = null;
      for (int attempt = 0; attempt < 5; attempt++) {
        result = RmGetList(session, out needed, ref count, values, out reasons);
        if (result == 0) {
          var output = new List<LockProcess>();
          for (int i = 0; i < count; i++) {
            var item = values[i];
            long start = ((long)item.Process.StartTime.dwHighDateTime << 32) | (uint)item.Process.StartTime.dwLowDateTime;
            output.Add(new LockProcess {
              pid = item.Process.ProcessId,
              creationTime = DateTime.FromFileTimeUtc(start).Ticks.ToString(),
              isProtected = item.ApplicationType == 3 || item.ApplicationType == 4 || item.ApplicationType == 1000
            });
          }
          return output.ToArray();
        }
        if (result != 234) throw new Win32Exception(result);
        count = needed;
        values = new ProcessInfo[count];
      }
      throw new InvalidOperationException("The locking process list kept changing.");
    } finally { RmEndSession(session); }
  }
}
'@
ConvertTo-Json -Compress -InputObject @([CShiftFileLocks]::Query($files))
`;

export async function listFileLockProcesses(target: string): Promise<FileLockScan> {
  if (process.platform !== "win32") return { processes: [], warnings: [] };
  const { files, incomplete } = await collectLockScanFiles(target);
  const warnings = incomplete ? ["文件占用扫描达到 5000 项上限或存在不可读目录，列表可能不完整。"] : [];
  if (!files.length) return { processes: [], warnings };
  const request = execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(RESTART_MANAGER_SCRIPT, "utf16le").toString("base64")
  ], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  // Send file names as data, avoiding command-length limits and shell quoting.
  request.child.stdin?.on("error", () => undefined);
  request.child.stdin?.end(JSON.stringify(files), "utf8");
  const { stdout } = await request;
  const raw: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  const records = Array.isArray(raw) ? raw : [raw];
  const processes = records.flatMap((item: unknown): FileLockProcess[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || typeof record.creationTime !== "string" || !/^\d+$/.test(record.creationTime)) return [];
    return [{ pid, creationTime: record.creationTime, protected: Boolean(record.isProtected) }];
  });
  return { processes, warnings };
}

export function sameProcessStartTime(first: string | undefined, second: string): boolean {
  // Win32_Process exposes microseconds; Restart Manager exposes 100 ns ticks.
  return Boolean(first && /^\d+$/.test(first) && /^\d+$/.test(second)) && BigInt(first!) / 10n === BigInt(second) / 10n;
}
