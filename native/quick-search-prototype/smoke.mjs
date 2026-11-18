import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const crate = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(crate, "../..");
const base = path.join(workspace, ".task-tmp");
const prototype = path.join(crate, "target", "release", "cshift-quick-search-prototype.exe");
const indexer = path.resolve(process.argv[2] || path.join(workspace, "native", "indexer", "target", "release", "cshift-indexer.exe"));
const fixture = await mkdtemp(path.join(base, "native-search-smoke-"));
const files = path.join(fixture, "files");
const directData = path.join(fixture, "direct");
const data = path.join(fixture, "client");
const filterPath = path.join(fixture, "queries.json");
const driverPath = path.join(fixture, "drive.ps1");
const environment = { ...process.env, TEMP: fixture, TMP: fixture };
const children = [];

function start(executable, args) {
  const process = spawn(executable, args, {
    cwd: fixture, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const exit = once(process, "exit");
  children.push({ process, exit });
  return { process, exit };
}

async function collect(child) {
  let output = "", errors = "";
  child.process.stdout.setEncoding("utf8").on("data", (value) => output += value);
  child.process.stderr.setEncoding("utf8").on("data", (value) => errors += value);
  const [code] = await child.exit;
  assert.equal(code, 0, errors);
  return output;
}

function directClient({ process, exit }) {
  let nextId = 0;
  let ready;
  const readiness = new Promise((resolve) => ready = resolve);
  const waiting = new Map();
  let contentCompletion;
  createInterface({ input: process.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "status" && message.status.state === "ready") ready();
    if (message.event === "contentStatus" && contentCompletion) {
      const { state, message: details } = message.status;
      if (state === "ready") contentCompletion.resolve();
      if (state === "error") contentCompletion.reject(new Error(details));
    }
    const response = waiting.get(message.id);
    if (response) {
      waiting.delete(message.id);
      if (message.ok) response.resolve(message);
      else response.reject(new Error(message.error || "Reference request failed"));
    }
  });
  function request({ op = "query", ...fields }) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      process.stdin.write(JSON.stringify({ id, op, ...fields }) + "\n");
    });
  }
  exit.then(() => {
    for (const { reject } of waiting.values()) reject(new Error("Reference indexer exited"));
    waiting.clear();
    contentCompletion?.reject(new Error("Reference indexer exited"));
  }, () => {});
  const indexContent = async (scope) => {
    const completed = new Promise((resolve, reject) => contentCompletion = { resolve, reject });
    try {
      await Promise.all([request({ op: "contentIndex", scope }), completed]);
    } finally {
      contentCompletion = undefined;
    }
  };
  return { request, readiness, indexContent };
}

const driver = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SearchSmoke {
  [DllImport("user32", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string name, string title);
  [DllImport("user32")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32")]
  public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Send(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Text(IntPtr window, uint message, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
}
'@
function Count-ListUntil([IntPtr]$list, [int]$expected) {
  for ($i=0; $i -lt 160; $i++) {
    $count = [IntPtr]::Zero
    if ([SearchSmoke]::Send($list, 4100, 0, 0, 2, 150, [ref]$count) -ne 0 -and [int]$count -eq $expected) { return }
    Start-Sleep -Milliseconds 60
  }
  throw "Result list did not reach $expected rows; last count $count"
}
function Set-Text([IntPtr]$control, [string]$value) {
  $unused = [IntPtr]::Zero
  if ([SearchSmoke]::Text($control, 12, 0, $value, 2, 800, [ref]$unused) -eq 0) { throw 'Cannot set native search field' }
}
function Send-Command([IntPtr]$target, [int]$id) {
  $unused = [IntPtr]::Zero
  if ([SearchSmoke]::Send($target, 273, $id, 0, 2, 800, [ref]$unused) -eq 0) { throw "Native search command $id failed" }
}
function Set-Mode([IntPtr]$target, [int]$mode) {
  $pick = [SearchSmoke]::GetDlgItem($target, 112)
  $unused = [IntPtr]::Zero
  if ([SearchSmoke]::Send($pick, 334, $mode, 0, 2, 800, [ref]$unused) -eq 0) { throw 'Cannot switch native search mode' }
  Send-Command $target (65536 + 112)
}
for ($attempt=0; $attempt -lt 100; $attempt++) {
  $window = [SearchSmoke]::FindWindow('CShiftQuickSearchPrototype', $null)
  if ($window -ne 0) {
    $actualOwner = [uint32]0
    [void][SearchSmoke]::GetWindowThreadProcessId($window, [ref]$actualOwner)
    if ($actualOwner -ne [uint32]$env:CSHIFT_PROTOTYPE_PID) { throw 'Found a window outside the smoke process' }
    break
  }
  Start-Sleep -Milliseconds 60
}
if ($window -eq 0) { throw 'The prototype window never appeared' }
$list = [SearchSmoke]::GetDlgItem($window, 111)
$query = [SearchSmoke]::GetDlgItem($window, 100)
$scope = [SearchSmoke]::GetDlgItem($window, 101)
$extensions = [SearchSmoke]::GetDlgItem($window, 102)
$additional = [SearchSmoke]::GetDlgItem($window, 115)
$minimum = [SearchSmoke]::GetDlgItem($window, 116)
$maximum = [SearchSmoke]::GetDlgItem($window, 117)
$after = [SearchSmoke]::GetDlgItem($window, 118)
$before = [SearchSmoke]::GetDlgItem($window, 119)
Set-Text $query 'report'
Set-Text $extensions 'txt'
Count-ListUntil $list 120
Send-Command $window 109
Count-ListUntil $list 40
Send-Command $window 108
Count-ListUntil $list 120
Set-Text $extensions 'rs'
Count-ListUntil $list 13
Set-Text $extensions 'txt'
Set-Text $minimum '6'
Set-Text $maximum '11'
Set-Text $after '2020-01-15'
Set-Text $before '2020-01-15'
Count-ListUntil $list ([int]$env:CSHIFT_RANGE_MATCHES)
Set-Text $minimum ''
Set-Text $maximum ''
Set-Text $after ''
Set-Text $before ''
Set-Text $query 'report-001'
Set-Text $additional ([String]::Join([Environment]::NewLine, @('report-002','report-003')))
Count-ListUntil $list 3

Set-Text $additional ''
Set-Text $scope $env:CSHIFT_CONTENT_SCOPE
Set-Mode $window 1
Set-Text $query 'scarlet'
Set-Text $additional 'azure'
Send-Command $window 113
Count-ListUntil $list 80
Send-Command $window 109
Count-ListUntil $list 55
Send-Command $window 108
Count-ListUntil $list 80

Set-Text $query 'scarlet'
Send-Command $window 110
Send-Command $window 114
Count-ListUntil $list 0
Start-Sleep -Milliseconds 300
Count-ListUntil $list 0
Set-Text $scope $env:CSHIFT_REPORTS_SCOPE
Set-Text $additional ''
Set-Mode $window 0
Set-Text $query 'report'
Count-ListUntil $list 120
$sample = Get-Process -Id ([int]$env:CSHIFT_PROTOTYPE_PID)
[pscustomobject]@{ pageSizes=@(120,40,120,13); rangeMatches=[int]$env:CSHIFT_RANGE_MATCHES; keywordOrMatches=3; contentPageSizes=@(80,55,80); cancelAndSwitch=$true; privateMiB=[Math]::Round($sample.PrivateMemorySize64/1MB,1); workingMiB=[Math]::Round($sample.WorkingSet64/1MB,1) } | ConvertTo-Json -Compress
$unused = [IntPtr]::Zero
[void][SearchSmoke]::Send($window, 16, 0, 0, 2, 800, [ref]$unused)
`;

let timer;
try {
  timer = setTimeout(() => {
    for (const { process } of children) {
      if (process.exitCode === null && process.signalCode === null) process.kill();
    }
  }, 45_000);
  timer.unref();
  const reports = path.join(files, "Reports");
  const content = path.join(files, "Text");
  const day1 = new Date(2020, 0, 15, 13);
  const day2 = new Date(2020, 0, 16, 13);
  await Promise.all([reports, content, directData, data].map((folder) => mkdir(folder, { recursive: true })));
  for (let index = 0; index < 173; index++) {
    const name = `report-${String(index).padStart(3, "0")}.${index < 160 ? "txt" : "rs"}`;
    const report = path.join(reports, name);
    const when = index < 80 ? day1 : day2;
    await writeFile(report, "x".repeat((index % 19) + 1));
    await utimes(report, when, when);
  }
  for (let index = 0; index < 135; index++) {
    await writeFile(path.join(content, `note-${String(index).padStart(3, "0")}.txt`),
      index % 2 === 0 ? "a scarlet kite" : "an azure balloon");
  }
  await writeFile(path.join(files, "备注.txt"), "unicode");
  const direct = start(indexer, ["--serve"]);
  const ipc = directClient(direct);
  await Promise.race([ipc.request({
    op: "init", root: files, cachePath: path.join(directData, "search-index-v1.bin"),
    contentCacheDir: path.join(directData, "content"), mouseButton: "disabled", magnifierEnabled: false
  }), direct.exit.then(() => { throw Error("Reference indexer exited before initialization"); })]);
  await Promise.race([ipc.readiness, direct.exit.then(() => { throw Error("Reference indexer exited before readiness"); })]);
  const first = { query: "report", scope: reports, kind: "file", extensions: ["txt"], sortBy: "name", sortDirection: "asc", limit: 120 };
  const page = await ipc.request(first);
  assert.equal(page.results.length, 120);
  assert.equal(page.totalMatches, 160);
  assert(page.nextCursor);
  const queries = [
    first, { ...first, cursor: page.nextCursor },
    { query: "^report-(00|01)", regex: true, scope: reports, minSize: 5, sortBy: "size", sortDirection: "desc", limit: 10 },
    { query: "rprt", fuzzy: true, extensions: ["rs"], limit: 10 },
    { query: "Reports", matchPath: true, kind: "file", extensions: ["rs"], limit: 13 },
    { query: "备注", limit: 1 },
    { ...first, keywords: ["report-001", "report-002", "report-003"] },
    { ...first, minSize: 6, maxSize: 11,
      modifiedAfterMs: +new Date(2020, 0, 15, 0), modifiedBeforeMs: +new Date(2020, 0, 15, 23, 59, 59) },
  ];
  const expected = [page];
  for (const filters of queries.slice(1)) expected.push(await ipc.request(filters));
  const rangeMatches = Array.from({ length: 80 }, (_, i) => i % 19 + 1).filter((size) => size >= 6 && size <= 11).length;
  assert.equal(expected.at(-2).totalMatches, 3);
  assert.equal(expected.at(-1).totalMatches, rangeMatches);
  await ipc.indexContent(content);
  const contentStart = { op: "contentQuery", scope: content, query: "scarlet", keywords: ["scarlet", "azure"], limit: 80, sortBy: "path", sortDirection: "asc" };
  const firstContent = await ipc.request(contentStart);
  assert.equal(firstContent.totalMatches, 135);
  assert.equal(firstContent.results.length, 80);
  const secondContent = { ...contentStart, cursor: firstContent.nextCursor };
  const contentRegex = { op: "contentQuery", scope: content, query: "scarlet (?:kite|balloon)", regex: true, limit: 20 };
  queries.push({ op: "contentIndex", scope: content }, contentStart, secondContent, contentRegex);
  expected.push(firstContent, await ipc.request(secondContent), await ipc.request(contentRegex));
  assert.equal(expected.at(-2).results.length, 55);
  await ipc.request({ op: "quit" });
  assert.equal((await direct.exit)[0], 0);
  const args = ["--indexer", indexer, "--root", files, "--data", data];
  await writeFile(filterPath, JSON.stringify(queries));
  const observed = JSON.parse(await collect(start(prototype, [...args, "--probe", filterPath])));
  assert.deepEqual(observed, expected.map(({ id, ok, ...result }) => result));

  await writeFile(driverPath, driver);
  const gui = start(prototype, args);
  const ui = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", driverPath], {
    cwd: fixture, env: { ...environment, CSHIFT_PROTOTYPE_PID: String(gui.process.pid), CSHIFT_RANGE_MATCHES: String(rangeMatches),
      CSHIFT_CONTENT_SCOPE: content, CSHIFT_REPORTS_SCOPE: reports },
    encoding: "utf8", windowsHide: true, timeout: 40_000
  });
  assert.equal((await gui.exit)[0], 0);
  console.log(JSON.stringify({ identicalEnginePages: observed.length, counts: observed.map((page) => page.totalMatches), gui: JSON.parse(ui) }, null, 2));
} finally {
  clearTimeout(timer);
  for (const { process, exit } of children) {
    if (process.exitCode === null && process.signalCode === null) process.kill();
    await exit.catch(() => {});
  }
  if (path.dirname(fixture) === base) await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
