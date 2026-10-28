import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(process.argv[2] || path.join(workspace, "release-v0.1.11/win-unpacked/CDriveShiftAI.exe"));
const sourceCache = path.join(workspace, ".cdriveshiftai-data/search-index-v1.bin");
const base = path.join(workspace, ".test-tmp");
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(path.join(base, "packaged-idle-"));
const sourceBefore = await stat(sourceCache);
await copyFile(sourceCache, path.join(fixture, "search-index-v1.bin"));
// This is an independent copy, not a hard link to the user's live cache.
await utimes(path.join(fixture, "search-index-v1.bin"), sourceBefore.atime, new Date());
await writeFile(path.join(fixture, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
  effectMode: "calm", launchAtLogin: false, launchMinimized: false, minimizeToTray: true,
  mouseQuickSearchButton: "disabled", magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: ""
} }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const environment = { ...process.env, CDRIVESHIFTAI_DATA_DIR: fixture, TEMP: fixture, TMP: fixture,
  CDRIVESHIFTAI_SMOKE_CLOSE_TO_TRAY_AFTER_READY_MS: "10000", CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "22000" };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [], { cwd: fixture, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: environment });
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk.toString(); });
const exited = once(child, "exit");

function snapshot() {
  const script = [
    "$all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();$null=$ids.Add([int]$env:CSHIFT_IDLE_PID);",
    "do{$count=$ids.Count;foreach($item in $all){if($ids.Contains([int]$item.ParentProcessId)){$null=$ids.Add([int]$item.ProcessId)}}}while($ids.Count -ne $count);",
    "$rows=@(foreach($processId in $ids){$item=Get-Process -Id $processId -ErrorAction SilentlyContinue;if($item){$meta=$all|Where-Object ProcessId -eq $processId|Select-Object -First 1;",
    "[PSCustomObject]@{pid=$item.Id;name=$item.ProcessName;cpu=$item.TotalProcessorTime.TotalSeconds;working=$item.WorkingSet64;private=$item.PrivateMemorySize64;renderer=([string]$meta.CommandLine -match '--type=renderer(?:\\s|$)')}}});",
    "[PSCustomObject]@{cpu=($rows|Measure-Object cpu -Sum).Sum;working=($rows|Measure-Object working -Sum).Sum;private=($rows|Measure-Object private -Sum).Sum;processes=$rows}|ConvertTo-Json -Depth 4 -Compress"
  ].join("");
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, encoding: "utf8", env: { ...environment, CSHIFT_IDLE_PID: String(child.pid) }
  }));
}

try {
  // Exercise normal visible startup/cache loading, followed by the app's own
  // close-to-tray path; wait for the hidden renderer to be released.
  await wait(12_000);
  assert.equal(child.exitCode, null, stderr);
  const before = snapshot(); const started = performance.now();
  await wait(6_000);
  const after = snapshot();
  const seconds = (performance.now() - started) / 1_000;
  const oneCore = (after.cpu - before.cpu) / seconds * 100;
  const countRenderers = after.processes.filter(item => item.renderer).length;
  assert.equal(countRenderers, 0, "Tray mode retained a renderer");
  const logs = await readdir(path.join(fixture, "logs"));
  const logText = (await Promise.all(logs.filter(name => /\.(?:log|jsonl)$/.test(name)).map(name => readFile(path.join(fixture, "logs", name), "utf8")))).join("\n");
  const readyLine = logText.split("\n").find(line => line.includes("indexer.status_changed") && line.includes('"state":"ready"'));
  const report = { executable, cacheCopyBytes: sourceBefore.size, loadedBeforeHiding: Boolean(readyLine),
    sampledIdleSeconds: +seconds.toFixed(2), idleOneCorePercent: +oneCore.toFixed(3),
    idleTaskManagerPercent: +(oneCore / (Number(process.env.NUMBER_OF_PROCESSORS) || 1)).toFixed(3),
    processTreeWorkingSetMiB: +(after.working / 1024 ** 2).toFixed(2), processTreePrivateMiB: +(after.private / 1024 ** 2).toFixed(2),
    rendererProcesses: countRenderers, processes: after.processes.map(item => ({ name: item.name,
      workingSetMiB: +(item.working / 1024 ** 2).toFixed(2), privateMiB: +(item.private / 1024 ** 2).toFixed(2) })) };
  console.log(JSON.stringify(report, null, 2));
  const [code] = await Promise.race([exited, wait(8_000).then(() => { throw new Error("Application did not stop after timed shutdown"); })]);
  assert.equal(code, 0, stderr);
  const sourceAfter = await stat(sourceCache);
  assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs, "The real cache was modified during this isolated test");
  assert.equal(sourceAfter.size, sourceBefore.size);
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, wait(2_000)]); }
  assert.equal(path.dirname(path.resolve(fixture)), base);
  assert(path.basename(fixture).startsWith("packaged-idle-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
