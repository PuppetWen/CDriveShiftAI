import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const crate = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(crate, "../..");
const base = path.join(workspace, ".task-tmp");
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(path.join(base, "native-hosted-smoke-"));
const driverPath = path.join(fixture, "drive.ps1");
const env = { ...process.env, TEMP: fixture, TMP: fixture };
const executable = path.resolve(process.argv[2] || path.join(crate, "target", "release", "cshift-quick-search-prototype.exe"));
const child = spawn(executable, ["--hosted", "--root", fixture], {
  cwd: fixture, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
});
const exit = once(child, "exit");
const lines = createInterface({ input: child.stdout });
const frames = on(lines, "line", { signal: AbortSignal.timeout(20_000), close: ["close"] });
let errors = "";
child.stderr.setEncoding("utf8").on("data", (value) => errors += value);

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

async function receive() {
  const { value, done } = await frames.next();
  assert(!done, `The hosted window closed before sending its next frame: ${errors}`);
  return JSON.parse(value[0]);
}

function reply(request, results) {
  send({ id: request.id, ok: true, results, hasMore: false, totalMatches: results.length, generation: 2 });
}

const drive = () => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", driverPath], {
  cwd: fixture, env: { ...env, CSHIFT_SMOKE_PID: String(child.pid) }, windowsHide: true, timeout: 10_000
});

try {
  await writeFile(driverPath, String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HostedSmoke {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32")]
  public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32")]
  public static extern bool GetWindowRect(IntPtr window, out Rect size);
  [DllImport("user32")]
  public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Send(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Text(IntPtr window, uint message, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
}
'@
$window = (Get-Process -Id ([int]$env:CSHIFT_SMOKE_PID)).MainWindowHandle
if ($window -eq 0) { throw 'The hosted window is not visible' }
$unused = [IntPtr]::Zero
function Set-Text($id, $value) {
  $edit = [HostedSmoke]::GetDlgItem($window, $id)
  if ([HostedSmoke]::Text($edit, 12, 0, $value, 2, 1000, [ref]$unused) -eq 0) { throw "Cannot set field $id" }
}
function Send-Control($target, $message, $value) {
  if ([HostedSmoke]::Send($target, $message, $value, 0, 2, 1000, [ref]$unused) -eq 0) { throw "Message $message failed" }
}
$list = [HostedSmoke]::GetDlgItem($window, 111)
$before = New-Object HostedSmoke+Rect
$after = New-Object HostedSmoke+Rect
if (-not [HostedSmoke]::SetWindowPos($window, 0, 0, 0, 1000, 620, 22) -or
    -not [HostedSmoke]::GetWindowRect($list, [ref]$before) -or
    -not [HostedSmoke]::SetWindowPos($window, 0, 0, 0, 1100, 720, 22) -or
    -not [HostedSmoke]::GetWindowRect($list, [ref]$after)) { throw 'Cannot resize the hosted window' }
if (($after.Right - $after.Left) -le ($before.Right - $before.Left) -or
    ($after.Bottom - $after.Top) -le ($before.Bottom - $before.Top)) { throw 'The result list did not resize with its window' }
Set-Text 100 'report'
Set-Text 102 '*.TXT|.rs;txt'
Send-Control ([HostedSmoke]::GetDlgItem($window, 105)) 334 2
Send-Control ([HostedSmoke]::GetDlgItem($window, 122)) 334 1
Send-Control $window 273 110
`);
  assert.deepEqual(await receive(), { event: "ready", protocol: 1 });
  assert.deepEqual(await receive(), { event: "visibility", visible: true });
  send({ event: "indexStatus", status: { state: "loading", message: "Loading smoke fixture" } });
  await drive();
  const first = await receive();
  assert.equal(first.op, "query");
  assert.equal(first.query, "report");
  assert.deepEqual(first.scopes, [fixture]);
  assert.deepEqual(first.extensions, ["txt", "rs"]);
  assert.equal(first.sortBy, "path");
  assert.equal(first.sortDirection, "asc");
  reply(first, []);

  send({ command: "hide" });
  assert.deepEqual(await receive(), { event: "visibility", visible: false });
  send({ event: "indexStatus", status: { state: "ready", message: "Smoke fixture indexed" } });
  send({ command: "show" });
  assert.deepEqual(await receive(), { event: "visibility", visible: true });
  const refreshed = await receive();
  assert(refreshed.id > first.id);
  assert.deepEqual({ ...refreshed, id: first.id }, first);
  reply(refreshed, [{ name: "report.txt", path: path.join(fixture, "report.txt"), size: 10, score: 1 }]);

  send({ command: "shutdown" });
  assert.deepEqual(await receive(), { event: "visibility", visible: false });
  assert.equal((await exit)[0], 0, errors);
  assert((await frames.next()).done, "The hosted window sent an additional request on shutdown");
  assert.deepEqual(await readdir(fixture), ["drive.ps1"], "The hosted window wrote its own index or cache");
  console.log("Hosted Win32 window showed under a hidden launcher, resized its result list, preserved filters, replayed on index readiness, and shut down without owning an index.");
} finally {
  await frames.return();
  lines.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exit.catch(() => {});
  if (path.dirname(fixture) === base) await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
