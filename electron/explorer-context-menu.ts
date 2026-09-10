import { execFile } from "node:child_process";
import path from "node:path";

export const EXPLORER_MENU_KEYS = [
  "Software\\Classes\\*\\shell\\CDriveShiftAI.ForceDelete",
  "Software\\Classes\\Directory\\shell\\CDriveShiftAI.ForceDelete"
] as const;

export interface ExplorerContextMenuOptions {
  isPackaged: boolean;
  executablePath: string;
  appPath?: string;
  portableExecutablePath?: string;
  platform?: NodeJS.Platform;
}

export interface ExplorerContextMenuStatus {
  supported: boolean;
  enabled: boolean;
  registered: boolean;
  needsRepair: boolean;
  command?: string;
}

interface MenuKeyState {
  exists: boolean;
  command: string;
  ownerExecutable: string;
  label: string;
  icon: string;
  multiSelectModel: string;
}

interface MenuRegistration {
  command: string;
  executable: string;
  label: string;
  icon: string;
  multiSelectModel: string;
  appPath?: string;
}

interface RegistrySnapshot {
  Exists: boolean;
  Tree: unknown;
}

interface RegistryResponse {
  status: ExplorerContextMenuStatus;
  snapshots?: RegistrySnapshot[];
}

export interface ExplorerContextMenuDependencies {
  /** Runs the fixed registry helper, never a renderer-provided command. */
  runRegistryScript?: (script: string) => Promise<string>;
}

function absoluteWindowsPath(value: string | undefined, name: string): string {
  // Drive-relative paths, embedded quotes and device namespaces must never become a launch command.
  if (typeof value !== "string" || !value || /[\x00-\x1f"<>|?*]/.test(value)
    || !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value)
    || /^\\\\[?.]\\/.test(value)) {
    throw new Error(`${name}必须是有效的 Windows 绝对路径`);
  }
  return path.win32.normalize(value);
}

function quotedWindowsArgument(value: string): string {
  // The application directory can end in a backslash, which must be doubled before its closing quote.
  return `"${value.replace(/(\\+)$/g, "$1$1")}"`;
}

function menuRegistration(options: ExplorerContextMenuOptions): MenuRegistration {
  const executable = absoluteWindowsPath(
    options.portableExecutablePath || options.executablePath,
    "程序路径"
  );
  if (path.win32.extname(executable).toLowerCase() !== ".exe") {
    throw new Error("资源管理器菜单的程序路径必须指向 .exe 文件");
  }
  const argumentsList = [quotedWindowsArgument(executable)];
  let appPath: string | undefined;
  if (!options.isPackaged && !options.portableExecutablePath) {
    appPath = absoluteWindowsPath(options.appPath, "开发项目路径");
    argumentsList.push(quotedWindowsArgument(appPath));
  }
  argumentsList.push('--force-delete-path "%1"');
  return {
    executable,
    command: argumentsList.join(" "),
    label: "CDriveShiftAI 强制删除",
    icon: `${quotedWindowsArgument(executable)},0`,
    multiSelectModel: "Single",
    appPath
  };
}

export function buildExplorerCommand(options: ExplorerContextMenuOptions): string {
  return menuRegistration(options).command;
}

const registryHelper = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$roots = @('Software\Classes\*\shell\CDriveShiftAI.ForceDelete', 'Software\Classes\Directory\shell\CDriveShiftAI.ForceDelete')
$hive = [Microsoft.Win32.Registry]::CurrentUser

function Read-Tree($key) {
  $values = @()
  foreach ($name in $key.GetValueNames()) {
    $values += [PSCustomObject]@{ Name=$name; Kind=$key.GetValueKind($name); Data=$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  }
  $children = @()
  foreach ($name in $key.GetSubKeyNames()) {
    $child = $key.OpenSubKey($name, $false)
    try { $children += [PSCustomObject]@{ Name=$name; Tree=(Read-Tree $child) } }
    finally { $child.Dispose() }
  }
  return [PSCustomObject]@{ Values=$values; Children=$children }
}

function Restore-Tree($key, $tree) {
  foreach ($value in $tree.Values) {
    $kind = [Microsoft.Win32.RegistryValueKind]$value.Kind
    $data = $value.Data
    switch ($kind) {
      Binary { $data = [byte[]]$data }
      None { $data = [byte[]]$data }
      MultiString { $data = [string[]]$data }
      DWord { $data = [int]$data }
      QWord { $data = [long]$data }
      default { $data = [string]$data }
    }
    $key.SetValue($value.Name, $data, $kind)
  }
  foreach ($child in $tree.Children) {
    $childKey = $key.CreateSubKey($child.Name)
    try { Restore-Tree $childKey $child.Tree }
    finally { $childKey.Dispose() }
  }
}

function Take-Snapshots {
  $snapshots = @()
  foreach ($root in $roots) {
    $key = $hive.OpenSubKey($root, $false)
    if ($null -eq $key) { $snapshots += [PSCustomObject]@{ Exists=$false; Tree=$null } }
    else {
      try { $snapshots += [PSCustomObject]@{ Exists=$true; Tree=(Read-Tree $key) } }
      finally { $key.Dispose() }
    }
  }
  return ,$snapshots
}

function Same-Tree($left, $right) {
  if (@($left.Values).Count -ne @($right.Values).Count -or @($left.Children).Count -ne @($right.Children).Count) { return $false }
  foreach ($value in $left.Values) {
    $other = @($right.Values | Where-Object { $_.Name -ceq $value.Name })
    if ($other.Count -ne 1 -or [int]$other[0].Kind -ne [int]$value.Kind) { return $false }
    if ((ConvertTo-Json -InputObject $other[0].Data -Compress) -cne (ConvertTo-Json -InputObject $value.Data -Compress)) { return $false }
  }
  foreach ($child in $left.Children) {
    $other = @($right.Children | Where-Object { $_.Name -ceq $child.Name })
    if ($other.Count -ne 1 -or !(Same-Tree $child.Tree $other[0].Tree)) { return $false }
  }
  return $true
}

function Read-State {
  $states = @()
  foreach ($root in $roots) {
    $key = $hive.OpenSubKey($root, $false)
    $state = [PSCustomObject]@{ exists=($null -ne $key); command=''; ownerExecutable=''; label=''; icon=''; multiSelectModel='' }
    if ($null -ne $key) {
      try {
        $state.ownerExecutable = [string]$key.GetValue('OwnerExecutable', '')
        $state.label = [string]$key.GetValue('', '')
        $state.icon = [string]$key.GetValue('Icon', '')
        $state.multiSelectModel = [string]$key.GetValue('MultiSelectModel', '')
        $command = $key.OpenSubKey('command', $false)
        if ($null -ne $command) {
          try { $state.command = [string]$command.GetValue('', '') }
          finally { $command.Dispose() }
        }
      } finally { $key.Dispose() }
    }
    $states += $state
  }
  return ,$states
}

# Keep both menu keys in one transaction. Snapshots live only in this process;
# registry changes are verified before success and restored if any step fails.
if (@('read', 'snapshot', 'enable', 'disable', 'restore') -notcontains $request.operation) { throw 'Unsupported menu operation.' }
if ($request.operation -eq 'restore' -and @($request.snapshots).Count -ne 2) { throw 'Invalid menu snapshot.' }
if ($request.operation -eq 'enable') {
  if (![System.IO.File]::Exists($request.registration.executable)) { throw 'The application executable no longer exists. Reopen CDriveShiftAI from its current location and retry.' }
  if ($request.registration.appPath -and ![System.IO.Directory]::Exists($request.registration.appPath)) { throw 'The development application directory no longer exists.' }
}
if (@('enable', 'disable', 'restore') -contains $request.operation) {
  $snapshots = Take-Snapshots
  try {
    for ($index = 0; $index -lt $roots.Count; $index++) {
      $root = $roots[$index]
      $hive.DeleteSubKeyTree($root, $false)
      if ($request.operation -eq 'enable') {
        $key = $hive.CreateSubKey($root)
        try {
          $key.SetValue('', [string]$request.registration.label, [Microsoft.Win32.RegistryValueKind]::String)
          $key.SetValue('Icon', [string]$request.registration.icon, [Microsoft.Win32.RegistryValueKind]::String)
          $key.SetValue('MultiSelectModel', [string]$request.registration.multiSelectModel, [Microsoft.Win32.RegistryValueKind]::String)
          $key.SetValue('OwnerExecutable', [string]$request.registration.executable, [Microsoft.Win32.RegistryValueKind]::String)
          $command = $key.CreateSubKey('command')
          try { $command.SetValue('', [string]$request.registration.command, [Microsoft.Win32.RegistryValueKind]::String) }
          finally { $command.Dispose() }
        } finally { $key.Dispose() }
      } elseif ($request.operation -eq 'restore' -and $request.snapshots[$index].Exists) {
        $key = $hive.CreateSubKey($root)
        try { Restore-Tree $key $request.snapshots[$index].Tree }
        finally { $key.Dispose() }
      }
    }
    $states = Read-State
    foreach ($state in $states) {
      if ($request.operation -eq 'disable') {
        if ($state.exists) { throw 'The Explorer menu key still exists after removal.' }
      } elseif ($request.operation -eq 'enable' -and (!$state.exists -or $state.command -cne $request.registration.command -or $state.ownerExecutable -cne $request.registration.executable -or $state.label -cne $request.registration.label -or $state.icon -cne $request.registration.icon -or $state.multiSelectModel -cne $request.registration.multiSelectModel)) {
        throw 'The Explorer menu registration did not match the requested command.'
      }
    }
    if ($request.operation -eq 'restore') {
      $restored = Take-Snapshots
      for ($index = 0; $index -lt $roots.Count; $index++) {
        if ($restored[$index].Exists -ne $request.snapshots[$index].Exists -or ($restored[$index].Exists -and !(Same-Tree $restored[$index].Tree $request.snapshots[$index].Tree))) { throw 'The restored Explorer menu did not match the original registration.' }
      }
    }
  } catch {
    $failure = $_.Exception.Message
    $rollbackFailures = @()
    for ($index = 0; $index -lt $roots.Count; $index++) {
      try {
        $hive.DeleteSubKeyTree($roots[$index], $false)
        if ($snapshots[$index].Exists) {
          $key = $hive.CreateSubKey($roots[$index])
          try { Restore-Tree $key $snapshots[$index].Tree }
          finally { $key.Dispose() }
        }
      } catch { $rollbackFailures += $_.Exception.Message }
    }
    try {
      $restored = Take-Snapshots
      for ($index = 0; $index -lt $roots.Count; $index++) {
        if ($restored[$index].Exists -ne $snapshots[$index].Exists -or ($restored[$index].Exists -and !(Same-Tree $restored[$index].Tree $snapshots[$index].Tree))) { throw 'Rollback verification did not match the original menu.' }
      }
    } catch { $rollbackFailures += $_.Exception.Message }
    if ($rollbackFailures.Count -gt 0) { throw ($failure + ' Rollback also failed: ' + ($rollbackFailures -join '; ')) }
    throw ($failure + ' Previous Explorer menu registration was restored.')
  }
} else { $states = Read-State }
$response = @{ keys=@($states) }
if ($request.operation -eq 'snapshot') { $response.snapshots = Take-Snapshots }
ConvertTo-Json -InputObject $response -Depth 100 -Compress
`;

function runRegistryScript(script: string): Promise<string> {
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Registry snapshots can exceed Windows' command-line length limit. Feed the
  // trusted helper through stdin; the only command-line script is this constant.
  const bootstrap = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => undefined); // execFile reports launch/exit errors.
    child.stdin?.end(script, "utf8");
  });
}

export class ExplorerContextMenuService {
  private readonly registration: MenuRegistration | undefined;
  private readonly runScript: (script: string) => Promise<string>;
  private readonly supported: boolean;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: ExplorerContextMenuOptions, dependencies: ExplorerContextMenuDependencies = {}) {
    this.supported = (options.platform ?? process.platform) === "win32";
    this.registration = this.supported ? menuRegistration(options) : undefined;
    this.runScript = dependencies.runRegistryScript ?? runRegistryScript;
  }

  private async run(operation: "read" | "snapshot" | "enable" | "disable" | "restore", snapshots?: RegistrySnapshot[]): Promise<RegistryResponse> {
    if (!this.registration) return { status: { supported: false, enabled: false, registered: false, needsRepair: false } };
    const payload = Buffer.from(JSON.stringify({ operation, registration: this.registration, snapshots }), "utf8").toString("base64");
    // Path characters, including quotes meaningful to shells, are data in a Base64 JSON payload.
    const script = `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${registryHelper}`;
    try {
      const result: unknown = JSON.parse((await this.runScript(script)).trim().replace(/^\uFEFF/, ""));
      if (!result || typeof result !== "object" || !("keys" in result) || !Array.isArray(result.keys) || result.keys.length !== 2) {
        throw new Error("无法读取资源管理器菜单状态");
      }
      const keys = result.keys as MenuKeyState[];
      if (keys.some((key) => !key || typeof key.exists !== "boolean" || [key.command, key.ownerExecutable, key.label, key.icon, key.multiSelectModel].some((value) => typeof value !== "string"))) {
        throw new Error("资源管理器菜单状态格式无效");
      }
      const registered = keys.some((key) => key.exists);
      const enabled = keys.every((key) => key.exists && key.command === this.registration!.command
        && key.ownerExecutable === this.registration!.executable && key.label === this.registration!.label
        && key.icon === this.registration!.icon && key.multiSelectModel === this.registration!.multiSelectModel);
      if ((operation === "enable" && !enabled) || (operation === "disable" && registered)) {
        throw new Error("资源管理器菜单更新后验证失败，请重新检查设置");
      }
      const resultSnapshots = "snapshots" in result ? result.snapshots : undefined;
      if (operation === "snapshot" && (!Array.isArray(resultSnapshots) || resultSnapshots.length !== 2
        || resultSnapshots.some((snapshot) => !snapshot || typeof snapshot.Exists !== "boolean" || !("Tree" in snapshot)))) {
        throw new Error("无法保存原有的资源管理器菜单状态");
      }
      return {
        status: { supported: true, enabled, registered, needsRepair: registered && !enabled, command: keys.find((key) => key.exists)?.command },
        snapshots: resultSnapshots as RegistrySnapshot[] | undefined
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const action = operation === "read" || operation === "snapshot" ? "检查" : operation === "enable" ? "添加" : operation === "restore" ? "恢复" : "移除";
      throw new Error(`无法${action}右键强制删除菜单：${detail}`);
    }
  }

  getStatus(): Promise<ExplorerContextMenuStatus> {
    return this.pending.catch(() => undefined).then(async () => (await this.run("read")).status);
  }

  setEnabled(enabled: boolean): Promise<ExplorerContextMenuStatus> {
    return this.withEnabled(enabled, async () => (await this.run("read")).status);
  }

  withEnabled<T>(enabled: boolean, commit: () => Promise<T>): Promise<T> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error("右键菜单设置必须为布尔值"));
    if (!this.supported) return Promise.reject(new Error("资源管理器右键菜单仅支持 Windows"));
    const operation = this.pending.catch(() => undefined).then(async () => {
      const original = await this.run("snapshot");
      try {
        await this.run(enabled ? "enable" : "disable");
        return await commit();
      } catch (error) {
        try { await this.run("restore", original.snapshots); }
        catch (rollbackError) {
          const detail = error instanceof Error ? error.message : String(error);
          const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`${detail}；还原原有右键菜单失败：${rollbackDetail}`);
        }
        throw error;
      }
    });
    this.pending = operation;
    return operation;
  }
}
