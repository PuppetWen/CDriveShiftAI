import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
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

export async function collectLockScanFiles(target: string, limit = 5_000): Promise<{ files: string[]; directories: string[]; incomplete: boolean }> {
  const files: string[] = [];
  const directories: string[] = [];
  const pending = [target];
  let visited = 0;
  let incomplete = false;
  while (pending.length) {
    const entryPath = pending.pop()!;
    if (++visited > limit) return { files, directories, incomplete: true };
    try {
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isFile()) files.push(entryPath);
      else if (stats.isDirectory()) {
        directories.push(entryPath);
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
  return { files, directories, incomplete };
}

// Only query resources. Do not use RmShutdown: termination must stay restricted
// to the identities shown in this application's confirmation dialog.
const RESTART_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$resources = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
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
  public class DirectoryScan {
    public LockProcess[] processes;
    public bool queryFailed;
    public bool incomplete;
    public bool identityUnavailable;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatusBlock { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr information, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder name, uint size, uint flags);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationFile(SafeFileHandle file, out IoStatusBlock status, IntPtr information, uint size, int informationClass);
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
  static string LongPath(string name) {
    return name.StartsWith(@"\\") ? @"\\?\UNC\" + name.Substring(2) : @"\\?\" + name;
  }
  static bool SameDirectory(SafeFileHandle file, string expected) {
    var name = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(file, name, (uint)name.Capacity, 0);
    if (length == 0 || length >= name.Capacity) return false;
    return String.Equals(name.ToString().TrimEnd('\\'), LongPath(expected).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
  }
  public static DirectoryScan QueryDirectories(string[] directories) {
    var result = new DirectoryScan();
    var matches = new Dictionary<int, LockProcess>();
    var timer = Stopwatch.StartNew();
    int queryPid;
    using (var queryProcess = Process.GetCurrentProcess()) queryPid = queryProcess.Id;
    foreach (string directory in directories) {
      if (timer.ElapsedMilliseconds > 8000) { result.incomplete = true; break; }
      try {
        // Query the selected directory itself, including empty directories and
        // current-directory handles that Restart Manager does not enumerate.
        // Never follow a reparse point or an ancestor replaced after traversal.
        using (var file = CreateFile(LongPath(directory), 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
          if (file.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            if (error != 2 && error != 3) result.queryFailed = true;
            continue;
          }
          IntPtr attributes = Marshal.AllocHGlobal(8);
          try {
            if (!GetFileInformationByHandleEx(file, 9, attributes, 8)) { result.queryFailed = true; continue; }
            uint flags = unchecked((uint)Marshal.ReadInt32(attributes));
            if ((flags & 0x400) != 0 || (flags & 0x10) == 0 || !SameDirectory(file, directory)) { result.incomplete = true; continue; }
          } finally { Marshal.FreeHGlobal(attributes); }
          for (int size = 4096; size <= 1048576; size *= 2) {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
              // Reject identities created after this query began, so a PID that
              // exits and is reused cannot name an unrelated new process.
              DateTime queryStarted = DateTime.UtcNow;
              IoStatusBlock block;
              int status = NtQueryInformationFile(file, out block, buffer, (uint)size, 47);
              uint nativeStatus = unchecked((uint)status);
              if (nativeStatus == 0x80000005 || nativeStatus == 0xC0000004 || nativeStatus == 0xC0000023) {
                if (size == 1048576) result.incomplete = true;
                continue;
              }
              if (status != 0) { result.queryFailed = true; break; }
              int count = Marshal.ReadInt32(buffer);
              if (count < 0 || count > (size - IntPtr.Size) / IntPtr.Size) { result.queryFailed = true; break; }
              for (int index = 0; index < count; index++) {
                long rawPid = Marshal.ReadIntPtr(buffer, IntPtr.Size + index * IntPtr.Size).ToInt64();
                if (rawPid <= 0 || rawPid > Int32.MaxValue || rawPid == queryPid) continue;
                int pid = (int)rawPid;
                try {
                  using (var process = Process.GetProcessById(pid)) {
                    DateTime started = process.StartTime.ToUniversalTime();
                    if (started > queryStarted || process.HasExited) { result.incomplete = true; continue; }
                    matches[pid] = new LockProcess {
                      pid = pid, creationTime = started.Ticks.ToString(),
                      isProtected = pid <= 4 || process.SessionId == 0
                    };
                  }
                } catch (ArgumentException) { result.incomplete = true; }
                  catch (InvalidOperationException) { result.incomplete = true; }
                  catch (Win32Exception) { result.identityUnavailable = true; }
              }
              break;
            } finally { Marshal.FreeHGlobal(buffer); }
          }
        }
      } catch { result.queryFailed = true; }
    }
    result.processes = new List<LockProcess>(matches.Values).ToArray();
    return result;
  }
}
'@
$files = [string[]]@($resources.files)
$directories = [string[]]@($resources.directories)
$fileProcesses = @()
$fileQueryFailed = $false
if ($files.Length -gt 0) {
  try { $fileProcesses = @([CShiftFileLocks]::Query($files)) }
  catch { $fileQueryFailed = $true }
}
$directoryScan = [CShiftFileLocks]::QueryDirectories($directories)
ConvertTo-Json -Depth 5 -Compress -InputObject @{
  processes = @($fileProcesses) + @($directoryScan.processes)
  fileQueryFailed = $fileQueryFailed
  directoryQueryFailed = $directoryScan.queryFailed
  directoryScanIncomplete = $directoryScan.incomplete
  directoryIdentityUnavailable = $directoryScan.identityUnavailable
}
`;

export async function listFileLockProcesses(target: string): Promise<FileLockScan> {
  if (process.platform !== "win32") return { processes: [], warnings: [] };
  if ((await lstat(target)).isSymbolicLink()) return { processes: [], warnings: [] };
  const { files, directories, incomplete } = await collectLockScanFiles(await realpath(target));
  const warnings = incomplete ? ["文件占用扫描达到 5000 项上限或存在不可读目录，列表可能不完整。"] : [];
  if (!files.length && !directories.length) return { processes: [], warnings };
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const request = execFileAsync(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(RESTART_MANAGER_SCRIPT, "utf16le").toString("base64")
  ], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  // Send file names as data, avoiding command-length limits and shell quoting.
  request.child.stdin?.on("error", () => undefined);
  request.child.stdin?.end(JSON.stringify({ files, directories }), "utf8");
  const { stdout } = await request;
  const raw: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("文件占用查询返回了无效结果");
  const scan = raw as Record<string, unknown>;
  if (scan.fileQueryFailed) warnings.push("Windows 文件句柄查询失败；部分文件占用进程可能未列出。");
  if (scan.directoryQueryFailed) warnings.push("Windows 目录句柄查询不受支持或被访问权限拒绝；请将终端切换到其他目录后重新预检。");
  if (scan.directoryScanIncomplete) warnings.push("目录占用扫描超时、目标变化或进程退出，列表可能不完整；请重新预检。");
  if (scan.directoryIdentityUnavailable) warnings.push("部分目录占用进程的身份不可读；请关闭相关终端或程序后重新预检。");
  const records = Array.isArray(scan.processes) ? scan.processes : [];
  const parsed = records.flatMap((item: unknown): FileLockProcess[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || typeof record.creationTime !== "string" || !/^\d+$/.test(record.creationTime)) return [];
    return [{ pid, creationTime: record.creationTime, protected: Boolean(record.isProtected) }];
  });
  const unique = new Map<string, FileLockProcess>();
  for (const item of parsed) {
    const key = `${item.pid}:${BigInt(item.creationTime) / 10n}`;
    const previous = unique.get(key);
    unique.set(key, { ...item, protected: Boolean(previous?.protected || item.protected) });
  }
  const processes = [...unique.values()];
  return { processes, warnings };
}

export function sameProcessStartTime(first: string | undefined, second: string): boolean {
  // Win32_Process exposes microseconds; Restart Manager exposes 100 ns ticks.
  return Boolean(first && /^\d+$/.test(first) && /^\d+$/.test(second)) && BigInt(first!) / 10n === BigInt(second) / 10n;
}
