import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { CORE_PROTECTED_PATHS, isPathWithin, normalizeWindowsPath, protectedReason, samePath } from "./system";

const execFileAsync = promisify(execFile);

export interface ElevatedDeleteRequest {
  path: string;
  canonicalPath: string;
  expectedIdentity: string;
  applicationExecutable: string;
  applicationDataRoot: string;
  applicationProcessId?: number;
  processes?: Array<{ pid: number; creationTime: string; name: string; executablePath?: string }>;
}

interface DeletePayload extends ElevatedDeleteRequest {
  protectedRoots: string[];
  applicationProcessId: number;
}

export interface ElevatedDeleteOperations {
  run: (executable: string, args: string[]) => Promise<void>;
}

export function elevatedDeleteIdentity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${stats.isSymbolicLink()}:${stats.isDirectory()}`;
}

// Every user value is serialized as data. Neither a selected path nor a PID is
// interpolated into PowerShell source. The elevated process never reads a
// replaceable .ps1 or request file from a user-writable temporary directory.
const NATIVE_DELETE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CShiftElevatedDelete {
  const uint Reparse = 0x400, DirectoryFlag = 0x10;
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint desired, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref Privileges privileges, uint size, IntPtr previous, IntPtr length);
  static void Fail(int code, string operation, string name) { throw new Win32Exception(code, operation + ": " + name); }
  static string Clean(string name) { return name.StartsWith(@"\\?\", StringComparison.Ordinal) ? name.Substring(4) : name; }
  static bool Same(string first, string second) { return String.Equals(first.TrimEnd('\\'), second.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
  static bool Within(string candidate, string parent) { return Same(candidate, parent) || candidate.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
  static string Normalize(string name) {
    if (String.IsNullOrEmpty(name) || name.Length < 4 || !Char.IsLetter(name[0]) || name[1] != ':' || name[2] != '\\' || name.IndexOf(':',2) >= 0 || name.IndexOfAny(new char[]{'*','?','\0','\r','\n','/'}) >= 0)
      Fail(126, "Only an explicit local absolute path is allowed", name);
    foreach (string part in name.Substring(3).Split('\\'))
      if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")) Fail(126, "Ambiguous path", name);
    string full = Path.GetFullPath(name).TrimEnd('\\');
    if (!Same(name,full) || full.Length < 4) Fail(126, "Invalid path", name);
    return full;
  }
  static void Protect(string name, string[] roots) {
    if (name.Length <= 3 || System.Text.RegularExpressions.Regex.IsMatch(name, @"^[a-z]:\\(?:WindowsApps|WpSystem)(?:\\|$)|\\AppData\\Local\\Packages(?:\\|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
      Fail(126, "Protected path", name);
    foreach (string root in roots) if (Within(name,root) || Within(root,name)) Fail(126, "Protected path", name);
    foreach (string container in new string[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)})
      if (!String.IsNullOrEmpty(container) && Within(container,name)) Fail(126, "Application container", name);
  }
  static Info Information(SafeFileHandle handle, string name) {
    Info value; if (!GetFileInformationByHandle(handle,out value)) Fail(Marshal.GetLastWin32Error(),"Read file identity",name);
    return value;
  }
  static string FinalName(SafeFileHandle handle, string name) {
    var text = new StringBuilder(32768);
    uint size = GetFinalPathNameByHandle(handle,text,(uint)text.Capacity,0);
    if (size == 0 || size >= text.Capacity) Fail(size == 0 ? Marshal.GetLastWin32Error() : 206,"Resolve file handle",name);
    return Clean(text.ToString());
  }
  static SafeFileHandle Open(string name, uint access, uint sharing = 3) {
    // Deny FILE_SHARE_DELETE while inspecting and traversing: ancestors and the
    // selected file object cannot be renamed/replaced underneath this operation.
    var handle = CreateFile(@"\\?\" + name, access, sharing, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); Fail(code,"Open exact file object",name); }
    return handle;
  }
  static void Identity(Info value, string expected, string name) {
    string[] parts = expected.Split(':');
    ulong index = ((ulong)value.IndexHigh << 32) | value.IndexLow;
    long creationTicks = (long)(((ulong)value.Creation.High << 32) | value.Creation.Low) - 116444736000000000L;
    bool link = (value.Attributes & Reparse) != 0;
    bool directory = !link && (value.Attributes & DirectoryFlag) != 0;
    // libuv reports the Windows volume serial, 64-bit file index and creation
    // FILETIME converted to Unix nanoseconds, without IEEE-754 rounding.
    if (parts.Length != 5 || parts[0] != value.Volume.ToString() || parts[1] != index.ToString() || parts[2] != (creationTicks * 100L).ToString() || parts[3] != link.ToString().ToLowerInvariant() || parts[4] != directory.ToString().ToLowerInvariant())
      Fail(125,"Target identity changed; preview again",name);
  }
  public static void EnablePrivileges() {
    IntPtr token; if (!OpenProcessToken(GetCurrentProcess(),0x28,out token)) return;
    try {
      foreach (string name in new string[]{"SeBackupPrivilege","SeRestorePrivilege","SeTakeOwnershipPrivilege"}) {
        Luid id; if (!LookupPrivilegeValue(null,name,out id)) continue;
        var value=new Privileges { Count=1, Id=id, Attributes=2 };
        AdjustTokenPrivileges(token,false,ref value,0,IntPtr.Zero,IntPtr.Zero);
      }
    } finally { CloseHandle(token); }
  }
  static List<string> Children(SafeFileHandle handle, string name) {
    var children = new List<string>(); IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool first = true;
      while (true) {
        bool result=GetFileInformationByHandleEx(handle, first ? 11 : 10,buffer,65536); first=false;
        if (!result) { int code=Marshal.GetLastWin32Error(); if(code==18) break; Fail(code,"Enumerate exact directory handle",name); }
        int offset=0;
        while(true) {
          IntPtr entry=IntPtr.Add(buffer,offset);
          int length=Marshal.ReadInt32(entry,60); int next=Marshal.ReadInt32(entry,0);
          if(length < 0 || (length % 2)!=0 || offset+104+length > 65536) Fail(13,"Invalid directory entry",name);
          string child=Marshal.PtrToStringUni(IntPtr.Add(entry,104),length/2);
          if(child!="." && child!="..") {
            if(String.IsNullOrEmpty(child) || child.IndexOfAny(new char[]{'\\','/',':','\0'})>=0 || child.EndsWith(".") || child.EndsWith(" ")) Fail(126,"Ambiguous directory entry",name);
            children.Add(Path.Combine(name,child));
          }
          if(next==0) break;
          if(next<104 || offset+next>=65536) Fail(13,"Invalid directory entry offset",name);
          offset+=next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    return children;
  }
  static void RemoveNode(string name, string expected, string[] roots, int depth) {
    if(depth>512) Fail(206,"Directory nesting limit exceeded",name);
    Protect(name,roots);
    // Backup/restore privileges bypass an ordinary ACL only for these exact
    // opened objects. We do not change ownership or ACLs of surviving files.
    using(var handle=Open(name,0x00010080)) { // DELETE | READ_ATTRIBUTES (no file-data access)
      Info info=Information(handle,name);
      if(!Same(FinalName(handle,name),name)) Fail(125,"Parent path changed",name);
      if(expected!=null) Identity(info,expected,name);
      bool link=(info.Attributes & Reparse)!=0;
      if(!link && (info.Attributes & DirectoryFlag)!=0) {
        List<string> children;
        // Only directory enumeration needs LIST_DIRECTORY. A second handle
        // shares DELETE with our already-pinned primary handle, which continues
        // to prevent another process from replacing this directory.
        using(var enumeration=Open(name,1,7)) { children=Children(enumeration,name); }
        foreach(string child in children) {
          try { RemoveNode(child,null,roots,depth+1); }
          catch(Win32Exception ex) { if(ex.NativeErrorCode!=2 && ex.NativeErrorCode!=3) throw; }
        }
      }
      // FileDispositionInfo deletes the opened object itself, including a link.
      // It never recursively follows a junction into another directory.
      IntPtr deletion=Marshal.AllocHGlobal(4);
      try {
        // Modern Windows can ignore ReadOnly for this unlink without changing
        // attributes shared by a hard link outside the selected tree.
        Marshal.WriteInt32(deletion,0x13); // DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE
        if(!SetFileInformationByHandle(handle,21,deletion,4)) {
          int code=Marshal.GetLastWin32Error();
          if(code!=1 && code!=50 && code!=87) Fail(code,"Delete exact file object",name);
          Marshal.WriteByte(deletion,1);
          if(!SetFileInformationByHandle(handle,4,deletion,1)) Fail(Marshal.GetLastWin32Error(),"Delete exact file object",name);
        }
      } finally { Marshal.FreeHGlobal(deletion); }
    }
  }
  public static void Delete(string target, string expected, string[] protectedRoots) {
    string name=Normalize(target);
    var roots=new List<string>(protectedRoots);
    string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    if(!String.IsNullOrEmpty(windows)) roots.Add(windows);
    Protect(name,roots.ToArray());
    var parents=new List<SafeFileHandle>();
    try {
      string parent=Path.GetDirectoryName(name);
      var ancestors=new Stack<string>();
      while(parent!=null && parent.Length>3) { ancestors.Push(parent); parent=Path.GetDirectoryName(parent); }
      while(ancestors.Count>0) {
        string ancestor=ancestors.Pop(); var handle=Open(ancestor,0x80); parents.Add(handle);
        if((Information(handle,ancestor).Attributes & Reparse)!=0 || !Same(FinalName(handle,ancestor),ancestor)) Fail(125,"Canonical parent changed",ancestor);
      }
      RemoveNode(name,expected,roots.ToArray(),0);
    } finally { for(int i=parents.Count-1;i>=0;i--) parents[i].Dispose(); }
  }
}
`;

const CHILD_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
function Expand-Text([string]$value) {
  $inputBytes=[IO.MemoryStream]::new([Convert]::FromBase64String($value))
  $gzip=[IO.Compression.GZipStream]::new($inputBytes,[IO.Compression.CompressionMode]::Decompress)
  $reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $inputBytes.Dispose() }
}
function Error-Code($failure) {
  $item=$failure.Exception
  while ($null -ne $item) {
    if($item -is [ComponentModel.Win32Exception]) { return $item.NativeErrorCode }
    $item=$item.InnerException
  }
  return 1
}
try {
  $request=ConvertFrom-Json -InputObject (Expand-Text '__REQUEST__')
  Add-Type -TypeDefinition (Expand-Text '__NATIVE__')
  [CShiftElevatedDelete]::EnablePrivileges()
  try { [CShiftElevatedDelete]::Delete([string]$request.canonicalPath,[string]$request.expectedIdentity,[string[]]$request.protectedRoots); exit 0 }
  catch { $firstCode=Error-Code $_; if($firstCode -notin @(5,32,33,145)) { throw } }
  $protectedPids=[Collections.Generic.HashSet[int]]::new()
  foreach($startId in @([int]$PID,[int]$request.applicationProcessId)) {
    $ancestorId=$startId
    while($ancestorId -gt 0 -and $protectedPids.Add($ancestorId)) {
      $ancestor=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ancestorId) -ErrorAction SilentlyContinue
      if($null -eq $ancestor) { break }
      $ancestorId=[int]$ancestor.ParentProcessId
    }
  }
  $never=@('system','registry','smss.exe','csrss.exe','wininit.exe','services.exe','lsass.exe','winlogon.exe','dwm.exe','explorer.exe','svchost.exe')
  $appRoot=[IO.Path]::GetDirectoryName([string]$request.applicationExecutable).TrimEnd('\')+'\'
  foreach($record in @($request.processes)) {
    if($null -eq $record -or [int]$record.pid -le 4 -or $protectedPids.Contains([int]$record.pid) -or [string]$record.creationTime -notmatch '^\d{2,}$') { continue }
    $processItem=$null
    try {
      $processItem=[Diagnostics.Process]::GetProcessById([int]$record.pid)
      $null=$processItem.Handle
      $actualName=$processItem.ProcessName+'.exe'
      $actualPath=$processItem.MainModule.FileName
      $ticks=$processItem.StartTime.ToUniversalTime().Ticks.ToString()
      $expectedTicks=[string]$record.creationTime
      $protectedExecutable=[string]::IsNullOrEmpty($actualPath)
      foreach($root in @($request.protectedRoots)) {
        if($actualPath -ieq [string]$root -or $actualPath.StartsWith(([string]$root).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { $protectedExecutable=$true; break }
      }
      if($actualName -in $never -or $actualName -ine [string]$record.name -or $protectedExecutable -or (-not [string]::IsNullOrEmpty([string]$record.executablePath) -and $actualPath -ine [string]$record.executablePath) -or $actualPath.StartsWith($appRoot,[StringComparison]::OrdinalIgnoreCase) -or $ticks.Substring(0,$ticks.Length-1) -ne $expectedTicks.Substring(0,$expectedTicks.Length-1)) { continue }
      $processItem.Kill()
      $null=$processItem.WaitForExit(5000)
    } catch { } finally { if($null -ne $processItem) { $processItem.Dispose() } }
  }
  [CShiftElevatedDelete]::Delete([string]$request.canonicalPath,[string]$request.expectedIdentity,[string[]]$request.protectedRoots)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit (Error-Code $_)
}
`;

function compressed(value: string): string { return gzipSync(Buffer.from(value, "utf8")).toString("base64"); }

/** The direct mode performs the same operation without requesting UAC elevation. */
export function buildElevatedDeleteCommand(payload: DeletePayload, direct = false): string[] {
  const child = CHILD_SCRIPT.replace("__REQUEST__", compressed(JSON.stringify(payload)))
    .replace("__NATIVE__", compressed(NATIVE_DELETE_SOURCE));
  const launcher = String.raw`
$ErrorActionPreference='Stop'
try {
  $stream=[IO.MemoryStream]::new([Convert]::FromBase64String('${compressed(child)}'))
  $gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionMode]::Decompress)
  $reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8)
  try { $script=$reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $stream.Dispose() }
  $administrator=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if($administrator ${direct ? "-or $true" : ""}) { & ([ScriptBlock]::Create($script)); exit $LASTEXITCODE }
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $powerShell=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $child=Start-Process -FilePath $powerShell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $child.ExitCode
} catch {
  $failure=$_.Exception
  while($null -ne $failure) {
    if($failure -is [ComponentModel.Win32Exception]) { exit $failure.NativeErrorCode }
    $failure=$failure.InnerException
  }
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;
  const encoded = Buffer.from(launcher, "utf16le").toString("base64");
  const childEncodedLength = Buffer.byteLength(child, "utf16le") * 4 / 3;
  if (encoded.length > 30_000 || childEncodedLength > 30_000) throw new Error("管理员删除请求过长，请减少目标路径长度或关联进程数量后重新检查");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

function normalizeLocalTarget(value: string): string {
  if (typeof value !== "string" || !/^[a-z]:\\/i.test(value) || /[\x00-\x1f*?]/.test(value) || value.slice(2).includes(":")) {
    throw new Error("管理员 PowerShell 删除仅支持明确的本机绝对路径，不能使用设备路径、网络共享或通配符");
  }
  const normalized = normalizeWindowsPath(value);
  if (!samePath(value, normalized) || value.split("\\").some((part) => part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new Error("管理员 PowerShell 删除路径无效，请重新检查");
  }
  const protection = protectedReason(normalized);
  if (protection) throw new Error(`受保护路径不能强制删除：${protection}`);
  return normalized;
}

function elevatedFailure(error: unknown): Error {
  const code = Number((error as { code?: unknown }).code);
  const messages: Record<number, string> = {
    5: "管理员 PowerShell 仍被访问权限或系统保护拒绝（Win32 5），请检查目标权限或使用对应应用卸载程序",
    32: "管理员 PowerShell 仍遇到文件占用（Win32 32）；请关闭占用应用，驱动或受保护服务的锁需要退出相关服务、重启或使用卸载程序处理",
    33: "管理员 PowerShell 仍遇到文件锁（Win32 33）；请停止占用应用后重新检查",
    125: "管理员删除前目标或父目录已发生变化，请重新预检",
    126: "受保护路径不能强制删除，或路径包含不能安全处理的目录项",
    145: "管理员 PowerShell 删除后目录仍非空（Win32 145），可能有后台程序持续写入；请停止同步、下载或更新后重试",
    1223: "DELETE_ELEVATION_CANCELLED：已取消管理员权限授权（UAC），未继续管理员删除；重新检查后可再次确认并允许权限请求"
  };
  const message = messages[code] ?? `管理员 PowerShell 删除失败${Number.isFinite(code) ? `（Win32 ${code}）` : ""}：系统未能完成此操作，请检查目标状态后重试`;
  return new Error([125, 126, 1223].includes(code) ? message : `DELETE_ELEVATION_FAILED：${message}`);
}

const DEFAULT_OPERATIONS: ElevatedDeleteOperations = {
  run: async (executable, args) => {
    // No timeout: killing just the UAC launcher could leave an elevated deletion
    // running while the UI incorrectly offers a second operation on this path.
    await execFileAsync(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  }
};

async function deleteUsingPowerShell(request: ElevatedDeleteRequest, elevate: boolean, operations: ElevatedDeleteOperations): Promise<void> {
  if (process.platform !== "win32") throw new Error("管理员 PowerShell 删除仅支持 Windows");
  const normalized = normalizeLocalTarget(request.path);
  const canonicalPath = normalizeLocalTarget(request.canonicalPath);
  const stats = await lstat(normalized, { bigint: true });
  const actualCanonical = normalizeLocalTarget(stats.isSymbolicLink()
    ? path.join(await realpath(path.dirname(normalized)), path.basename(normalized))
    : await realpath(normalized));
  if (!samePath(actualCanonical, canonicalPath) || elevatedDeleteIdentity(stats) !== request.expectedIdentity) {
    throw new Error("管理员删除前目标已被替换或路径发生变化，请重新预检");
  }
  const protectedRoots = [...CORE_PROTECTED_PATHS, path.dirname(request.applicationExecutable), request.applicationDataRoot];
  for (const root of [...protectedRoots]) {
    const canonicalRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
      // Some core Windows directories deliberately deny metadata access even to
      // an administrator. Their lexical path is still protected, and elevated
      // traversal rejects unresolved reparse ancestors independently.
      if (error.code === "ENOENT" || (CORE_PROTECTED_PATHS.includes(root) && ["EPERM", "EACCES"].includes(error.code ?? ""))) return root;
      throw error;
    });
    protectedRoots.push(canonicalRoot);
  }
  if (protectedRoots.some((root) => isPathWithin(normalized, root) || isPathWithin(root, normalized) || isPathWithin(canonicalPath, root) || isPathWithin(root, canonicalPath))) {
    throw new Error("受保护路径不能强制删除：目标包含系统、CDriveShiftAI 当前程序或数据目录");
  }
  const payload: DeletePayload = {
    ...request, path: normalized, canonicalPath, protectedRoots: [...new Set(protectedRoots)],
    applicationProcessId: request.applicationProcessId ?? process.pid,
    processes: request.processes?.filter((item) => Number.isInteger(item.pid) && item.pid > 4 && /^\d{2,}$/.test(item.creationTime)).slice(0, 32)
  };
  const args = buildElevatedDeleteCommand(payload, !elevate);
  try {
    await operations.run(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args);
  } catch (error) {
    const nativeCode = Number((error as { code?: unknown }).code);
    if ([2, 3].includes(nativeCode)) {
      try { await lstat(normalized); }
      catch (inspectionError) { if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") return; }
    }
    if (elevate) throw elevatedFailure(error);
    const errorCode: Record<number, string> = { 5: "EPERM", 32: "EBUSY", 33: "EBUSY", 145: "ENOTEMPTY" };
    if (errorCode[nativeCode]) {
      throw Object.assign(new Error(`PowerShell 精确删除失败（Win32 ${nativeCode}）：${normalized}`), { code: errorCode[nativeCode], path: normalized });
    }
    throw elevatedFailure(error);
  }
  try {
    await lstat(normalized);
    throw new Error("管理员 PowerShell 返回后目标仍然存在或已被重新创建，请重新预检；删除未完成");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function deleteWithElevation(request: ElevatedDeleteRequest, operations: ElevatedDeleteOperations = DEFAULT_OPERATIONS): Promise<void> {
  return deleteUsingPowerShell(request, true, operations);
}

export async function deleteWithoutElevation(request: ElevatedDeleteRequest, operations: ElevatedDeleteOperations = DEFAULT_OPERATIONS): Promise<void> {
  return deleteUsingPowerShell({ ...request, processes: undefined }, false, operations);
}
