import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Local release gate: real packaged helper + portable application, using a
// disposable native update plan. No installed-product installer is executed.
// The old executable's actual version is checked, but it is not started. This
// checks packaging/startup/cleanup, not UpdateService networking or old helpers.
// Usage: node scripts/smoke-packaged-update.mjs --version 0.2.2 --old-version
// 0.2.1 --report review-artifacts/packaged-update-0.2.2.json
assert.equal(process.platform, "win32", "This smoke test requires Windows");
const workspace = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `Missing value for ${name}`);
  return process.argv[index + 1];
};
const version = option("--version", "0.2.2");
const oldVersion = option("--old-version", "0.2.1");
assert.match(version, /^\d\.\d\.\d$/);
assert.match(oldVersion, /^\d+\.\d+\.\d+$/);
assert.notEqual(oldVersion, version);
const release = path.resolve(option("--release-dir", path.join(workspace, `release-v${version}`)));
const oldPortable = path.resolve(option("--old-portable", path.join(workspace, `release-v${oldVersion}/CDriveShiftAI-x64-portable.exe`)));
const newPortable = path.join(release, "CDriveShiftAI-x64-portable.exe");
const helperSource = path.join(release, "win-unpacked/resources/bin/cshift-updater.exe");
const reportOption = option("--report", undefined);
const reportPath = reportOption && path.resolve(workspace, reportOption);
if (reportPath) {
  const relative = path.relative(workspace, reportPath);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Report must stay in this project");
}
const keep = process.argv.includes("--keep");
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "packaged-update-"));
const distribution = path.join(fixture, "distribution");
const target = path.join(distribution, "CDriveShiftAI-packaged-smoke.exe");
const data = path.join(distribution, ".cdriveshiftai-data");
const staging = path.join(distribution, ".cdriveshiftai-update", version);
const runner = path.join(distribution, ".cdriveshiftai-update-runner");
const helperPath = path.join(staging, "cshift-updater.exe");
const planPath = path.join(staging, "update-plan.json");
const successPath = path.join(staging, "update-success.json");
const logPath = path.join(staging, "update.log");
const packagePath = path.join(staging, "CDriveShiftAI-x64-portable.exe");
const sentinelPath = path.join(data, "packaged-update-sentinel.txt");
const sentinel = "keep isolated user settings, index and migration data";
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
    "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ELECTRON_RUN_AS_NODE", "PORTABLE_EXECUTABLE_FILE",
    "PORTABLE_EXECUTABLE_DIR", "CDRIVESHIFTAI_SMOKE_CLOSE_TO_TRAY_AFTER_READY_MS"
  ].includes(key.toUpperCase()))),
  TEMP: path.join(fixture, "temp"), TMP: path.join(fixture, "temp"),
  APPDATA: path.join(fixture, "profile/roaming"), LOCALAPPDATA: path.join(fixture, "profile/local"),
  CDRIVESHIFTAI_DATA_DIR: data, CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "15000"
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = candidate => stat(candidate).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const digest = async (candidate, algorithm = "sha512") => createHash(algorithm).update(await readFile(candidate)).digest("hex");
let helper, helperError = "", helperLog = "", success, ready, confirmed, shutdown, window, aliveAfterHelperExit = false;
let helperExitAt;
const ownedPids = new Set();

function powershell(script, extra = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script], {
    env: { ...environment, ...extra }, windowsHide: true, encoding: "utf8", timeout: 15000
  }).trim();
}
function fileVersion(candidate) {
  return powershell("(Get-Item -LiteralPath $env:CSHIFT_FILE).VersionInfo.FileVersion", { CSHIFT_FILE: candidate });
}
function snapshot(pid) {
  const text = powershell("$p=Get-Process -Id ([int]$env:CSHIFT_PID) -ErrorAction SilentlyContinue;if($p){[PSCustomObject]@{pid=$p.Id;path=$p.Path;windowHandle=$p.MainWindowHandle.ToInt64();windowTitle=$p.MainWindowTitle}|ConvertTo-Json -Compress};exit 0", { CSHIFT_PID: String(pid) });
  return text ? JSON.parse(text) : undefined;
}
function insideFixture(candidate) {
  const relative = path.relative(fixture, path.resolve(candidate));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function events() {
  const logDirectory = path.join(data, "logs");
  let files;
  try { files = await readdir(logDirectory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const content = await Promise.all(files.filter(name => /^main-.*\.jsonl$/.test(name)).map(name => readFile(path.join(logDirectory, name), "utf8")));
  return content.flatMap(text => text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
}
function stopFixtureProcesses() {
  // Every termination requires both a PID and an executable path under the
  // unique fixture. No image-name kills, D: targets, or unrelated processes.
  powershell([
    "$root=[IO.Path]::GetFullPath($env:CSHIFT_FIXTURE).TrimEnd('\\')+'\\';",
    "$known=[Collections.Generic.HashSet[int]]::new();foreach($v in ($env:CSHIFT_PIDS -split ',')){if($v){$null=$known.Add([int]$v)}};",
    "$all=@(Get-CimInstance Win32_Process);",
    "foreach($p in $all){if($p.ExecutablePath -and [IO.Path]::GetFullPath($p.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){$null=$known.Add([int]$p.ProcessId)}};",
    "foreach($p in $all){if($known.Contains([int]$p.ProcessId) -and $p.ExecutablePath -and [IO.Path]::GetFullPath($p.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){Invoke-CimMethod -InputObject $p -MethodName Terminate -ErrorAction SilentlyContinue|Out-Null}}"
  ].join(""), { CSHIFT_FIXTURE: fixture, CSHIFT_PIDS: [...ownedPids].join(",") });
}

try {
  for (const directory of [distribution, data, staging, runner, environment.TEMP, environment.APPDATA, environment.LOCALAPPDATA]) await mkdir(directory, { recursive: true });
  await copyFile(oldPortable, target);
  await copyFile(newPortable, packagePath);
  await copyFile(helperSource, helperPath);
  await copyFile(helperSource, path.join(runner, `CDriveShiftAI-Update-${version}.exe`));
  assert.equal(fileVersion(target), oldVersion, "Old fixture metadata is not the requested version");
  assert.equal(fileVersion(packagePath), version, "New portable metadata is not the release version");
  const manifest = JSON.parse(await readFile(path.join(release, "update-manifest.json"), "utf8"));
  const expectedSha512 = await digest(packagePath);
  const helperSha256 = await digest(helperPath, "sha256");
  assert.equal(manifest.version, version);
  assert.equal(manifest.assets.portable.sha512, expectedSha512);
  assert.equal(manifest.assets.portable.size, (await stat(packagePath)).size);
  await writeFile(sentinelPath, sentinel);
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
    effectMode: "calm", launchAtLogin: false, launchMinimized: false, minimizeToTray: false,
    mouseQuickSearchButton: "disabled", magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: "",
    forceDeleteContextMenu: false, indexRoots: [fixture], ai: { enabled: false }
  } }));
  await writeFile(planPath, JSON.stringify({ schemaVersion: 1, mode: "portable", parentPid: 0,
    packagePath, targetPath: target, stagingDir: staging, backupPath: path.join(staging, "previous-version.exe"),
    successMarker: successPath, expectedVersion: version, expectedSha512, logPath, runnerDirectory: runner }, null, 2));
  console.log(`PACKAGED_UPDATE ${oldVersion} -> ${version}; helper SHA256 ${helperSha256}`);
  helper = spawn(helperPath, ["--plan", planPath], {
    cwd: data, env: environment, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
  });
  ownedPids.add(helper.pid);
  helper.on("error", error => { helperError += String(error); });
  helper.stderr.on("data", chunk => { helperError += chunk.toString(); });
  helper.once("exit", () => { helperExitAt = Date.now(); });
  const started = Date.now();
  let nextWindowCheck = 0;
  while (Date.now() - started < 45_000) {
    try { success = JSON.parse(await readFile(successPath, "utf8")); } catch {}
    try { helperLog = await readFile(logPath, "utf8"); } catch {}
    const allEvents = await events();
    ready = allEvents.find(event => event.event === "application.ready" && event.fields?.version === version) ?? ready;
    confirmed = allEvents.find(event => event.event === "update.startup_confirmed" && event.fields?.version === version) ?? confirmed;
    shutdown = allEvents.find(event => event.event === "application.shutdown_completed" && event.pid === ready?.pid) ?? shutdown;
    assert(!allEvents.some(event => ["application.startup_failed", "update.startup_window_failed", "process.uncaught_exception", "process.unhandled_rejection"].includes(event.event)), "Packaged application reported startup failure");
    assert(!/rolling back|update failed/i.test(helperLog), "Native helper attempted rollback");
    if (ready && Date.now() >= nextWindowCheck && !shutdown) {
      ownedPids.add(ready.pid);
      nextWindowCheck = Date.now() + 800;
      const current = snapshot(ready.pid);
      if (current?.windowHandle && /CDriveShiftAI/.test(current.windowTitle)) {
        assert(insideFixture(current.path), "New app process escaped the test fixture");
        window = current;
        if (helperExitAt && Date.now() - helperExitAt >= 3000) aliveAfterHelperExit = true;
      }
    }
    if (helper.exitCode !== null && helper.exitCode !== 0) throw Error(`Packaged helper exited ${helper.exitCode}: ${helperError}`);
    if (helperError && !helper.pid) throw Error(helperError);
    if (shutdown && success && window && aliveAfterHelperExit && helper.exitCode === 0) break;
    await wait(150);
  }
  assert(ready, "New packaged app did not initialize");
  assert(confirmed, "New packaged app did not confirm a loaded, visible window");
  assert(window, "New packaged app did not open a native main window");
  assert(success, "New packaged app did not write the startup success marker");
  assert.equal(success.version, version);
  assert.equal(success.pid, ready.pid);
  assert.equal(helper.exitCode, 0, helperError || helperLog);
  assert.match(helperLog, /helper SHA-512 verification passed/);
  assert.match(helperLog, /new portable version reported a successful start/);
  assert(aliveAfterHelperExit, "App did not remain visible after the native helper released its job");
  assert(shutdown, "Packaged app did not complete its 15-second graceful shutdown");
  const runtimeMs = Date.parse(shutdown.timestamp) - Date.parse(ready.timestamp);
  assert(runtimeMs >= 14_500 && runtimeMs < 35_000, `Unexpected graceful shutdown timing: ${runtimeMs} ms`);
  for (let attempt = 0; attempt < 40 && snapshot(ready.pid); attempt++) await wait(150);
  assert.equal(snapshot(ready.pid), undefined, "Packaged main process remained after graceful shutdown");
  assert.equal(await exists(staging), false, "Update staging was not automatically cleaned");
  assert.equal(await exists(runner), false, "Update runner was not automatically cleaned");
  assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
  assert.equal(fileVersion(target), version);
  assert.equal(await digest(target), expectedSha512);
  const report = { result: "ok", mode: "local-packaged-portable-plan", oldVersion, version,
    releaseDirectory: release, helperSha256, portableSha512: expectedSha512,
    portableBytes: (await stat(target)).size, helperExitCode: helper.exitCode,
    startupMarkerVersion: success.version, startupConfirmed: true, mainWindowOpened: true,
    mainWindowTitle: window.windowTitle, aliveAfterHelperExit: true, gracefulShutdown: true, runtimeMs,
    dataSentinelPreserved: true, stagingCleaned: true, runnerCleaned: true,
    testingScope: "Real packaged helper and portable app with a local native update plan; old executable metadata is verified but old app is not started. No UpdateService download, installed-product installer, or original old helper is exercised.",
    fixture: keep ? fixture : undefined };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
} catch (error) {
  console.error(JSON.stringify({ result: "failed", fixture: keep ? fixture : undefined,
    reason: error instanceof Error ? error.message : String(error), helperLog, helperError,
    ready, confirmed, shutdown, success, window }, null, 2));
  throw error;
} finally {
  stopFixtureProcesses();
  if (!keep) {
    assert.equal(path.dirname(path.resolve(fixture)), temporaryRoot);
    assert(path.basename(fixture).startsWith("packaged-update-"));
    await rm(fixture, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
  }
}
