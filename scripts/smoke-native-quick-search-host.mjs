import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

// Supply a valid local name-index cache to keep the smoke from scanning host drives.
assert.equal(process.platform, "win32");
assert(process.argv[2], "Usage: node scripts/smoke-native-quick-search-host.mjs INDEX_CACHE");
const workspace = path.resolve(import.meta.dirname, "..");
const sampleMemory = process.argv.includes("--sample-memory");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "native-quick-host-"));
const data = path.join(fixture, "data");
const system = process.env.SystemRoot ?? "C:\\Windows";
const powershell = path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe");
const run = promisify(execFile);
const env = { ...process.env, TEMP: fixture, TMP: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
  CDRIVESHIFTAI_DATA_DIR: data, CDRIVESHIFTAI_DISABLE_WATCHERS: "1", CSHIFT_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
const harness = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, globalShortcut } = require("electron");
const main = path.join(process.env.CSHIFT_WORKSPACE, "dist-electron");
const { NativeQuickSearchHost } = require(path.join(main, "native-quick-search.js"));
const { SearchService } = require(path.join(main, "search.js"));
globalShortcut.register = () => true;
const originalReceive = NativeQuickSearchHost.prototype.receive;
let visibleEvents = 0;
NativeQuickSearchHost.prototype.receive = function(session, line) {
  originalReceive.call(this, session, line);
  const message = JSON.parse(line);
  if (message.event === "visibility") {
    process.stdout.write(JSON.stringify({ visible: message.visible, pid: session.child.pid }) + "\n");
    if (message.visible && ++visibleEvents === 2) setTimeout(() => app.quit(), 300);
  }
};
const originalPage = SearchService.prototype.searchPage;
let seenService;
let requestCount = 0;
SearchService.prototype.searchPage = async function(query, filters, options, owner) {
  const page = await originalPage.call(this, query, filters, options, owner);
  if (owner >= 0 || query !== "kernel32.dll" || !page.items.length) return page;
  assert.equal(BrowserWindow.getAllWindows().length, 0, "Native search must start without a Chromium window");
  if (seenService) assert.equal(this, seenService, "Both requests must use the same index service");
  seenService = this;
  const webPage = await originalPage.call(this, query, filters, options, 99999);
  assert.deepEqual(webPage, page, "Native and browser search must return the same page");
  requestCount += 1;
  process.stdout.write(JSON.stringify({ matches: page.items.length, requestCount }) + "\n");
  return page;
};
require(path.join(main, "main.js"));
`;
const driver = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeSearchDrive {
  [DllImport("user32", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string type, string title);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr wnd, out uint pid);
  [DllImport("user32")] public static extern IntPtr GetDlgItem(IntPtr wnd, int id);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Message(IntPtr wnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Text(IntPtr wnd, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32")] public static extern bool ShowWindowAsync(IntPtr wnd, int cmd);
}
'@
$window = [NativeSearchDrive]::FindWindow('CShiftQuickSearchPrototype', $null)
$owner = [uint32]0
[void][NativeSearchDrive]::GetWindowThreadProcessId($window, [ref]$owner)
if (!$window -or $owner -ne [uint32]$env:CSHIFT_NATIVE_PID) { throw 'Native search window did not belong to this fixture' }
$ignored = [IntPtr]::Zero
switch ($env:CSHIFT_NATIVE_ACTION) {
  'search' {
    $query = [NativeSearchDrive]::GetDlgItem($window, 100)
    $list = [NativeSearchDrive]::GetDlgItem($window, 111)
    if ([NativeSearchDrive]::Text($query, 12, 0, 'kernel32.dll', 2, 1000, [ref]$ignored) -eq 0) { throw 'Cannot type query' }
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
      if ([NativeSearchDrive]::Message($list, 4100, 0, 0, 2, 150, [ref]$ignored) -ne 0 -and [int]$ignored -gt 0) {
        Write-Output ([int]$ignored)
        exit 0
      }
      Start-Sleep -Milliseconds 55
    }
    throw 'Native search did not display rows'
  }
  'memory' {
    $processes = @(Get-CimInstance Win32_Process)
    $ids = [Collections.Generic.HashSet[int]]::new()
    $null = $ids.Add([int]$env:CSHIFT_ELECTRON_PID)
    do {
      $count = $ids.Count
      foreach ($process in $processes) {
        if ($ids.Contains([int]$process.ParentProcessId)) { $null = $ids.Add([int]$process.ProcessId) }
      }
    } while ($count -ne $ids.Count)
    $rows = @(Get-Process -Id ([int[]]@($ids)) -ErrorAction SilentlyContinue)
    [pscustomobject]@{
      processCount = $rows.Count
      workingMiB = [math]::Round(($rows | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1)
      privateCommitMiB = [math]::Round(($rows | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
    } | ConvertTo-Json -Compress
  }
  'minimize' { [void][NativeSearchDrive]::ShowWindowAsync($window, 6) }
  'restore' { [void][NativeSearchDrive]::ShowWindowAsync($window, 9) }
}
`;

let child;
let exited;
let output = "";
let errors = "";
const events = () => output.split("\n").slice(0, -1).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
async function untilEvent(predicate, description, timeout = 18_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && child.exitCode === null) {
    const event = events().find(predicate);
    if (event) return event;
    await sleep(45);
  }
  assert.fail(`${description}\n${output}\n${errors}`);
}

try {
  await mkdir(data);
  const index = path.join(data, "search-index-v1.bin");
  await copyFile(path.resolve(process.argv[2]), index);
  await utimes(index, new Date(), new Date());
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
    language: "zh-CN", launchAtLogin: false, minimizeToTray: true, mouseQuickSearchButton: "disabled",
    magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: ""
  } }));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "native-quick-host-smoke", main: "main.cjs" }));
  await writeFile(path.join(fixture, "main.cjs"), harness);
  const driverFile = path.join(fixture, "native-driver.ps1");
  await writeFile(driverFile, "\uFEFF" + driver);
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"), [fixture, "--quick-search"], {
    cwd: fixture, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  exited = once(child, "exit");
  const { pid } = await untilEvent((event) => event.visible === true, "Native search startup timed out");
  async function drive(action) {
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-File", driverFile], {
      env: { ...env, CSHIFT_NATIVE_PID: String(pid), CSHIFT_ELECTRON_PID: String(child.pid), CSHIFT_NATIVE_ACTION: action },
      windowsHide: true, timeout: 16_000
    });
    return stdout.trim();
  }
  const shownRows = Number(await drive("search"));
  const first = await untilEvent((event) => event.requestCount === 1, "Search did not use the shared service");
  assert.equal(shownRows, first.matches);
  const memoryAfterSearch = sampleMemory ? JSON.parse(await drive("memory")) : undefined;
  await drive("minimize");
  await untilEvent((event) => event.visible === false, "Minimize did not release foreground search mode");
  await drive("restore");
  await untilEvent(() => events().filter((event) => event.visible === true).length === 2, "Restore did not resume foreground search mode");
  const [code] = await Promise.race([exited, sleep(8_000, [undefined], { ref: false })]);
  assert.equal(code, 0, errors || "Application did not shut down gracefully");
  const log = await readFile(path.join(data, "logs", `main-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  assert.equal(log.match(/"event":"indexer\.spawn_requested"/g)?.length, 1, "Quick and web search launched duplicate indexers");
  assert.match(log, /indexer\.exited/);
  console.log(JSON.stringify({ result: "ok", shownRows, nativeAndBrowserResultsEqual: true,
    singleIndexer: true, opensWithoutChromiumWindow: true, minimizeAndRestore: true, gracefulShutdown: true, memoryAfterSearch }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await run(path.join(system, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
      env, windowsHide: true, timeout: 8000
    }).catch(() => child.kill());
    await exited;
  }
  assert(fixture.startsWith(tempRoot + path.sep));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
