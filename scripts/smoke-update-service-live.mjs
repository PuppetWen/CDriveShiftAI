import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Exercise the real UpdateService and native helper with a disposable portable
// target. No installed-product installer, registration, AI service, or user data
// is touched. The harness only supplies old packaged-app metadata; networking,
// SHA-512 verification, helper handoff and the newly launched app are real.
// Prerequisites: compiled dist-electron and native updater, and an older portable
// fixture. Example: node scripts/smoke-update-service-live.mjs --expected-version
// 0.2.0 --report review-artifacts/update-service-live.json. Omit expected-version
// to follow the official latest release. --keep retains only this run's fixture.
assert.equal(process.platform, "win32", "This regression requires Windows");
const workspace = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const oldPortable = path.resolve(option("--old-portable", path.join(workspace, "release-v0.1.12/CDriveShiftAI-x64-portable.exe")));
const helperSource = path.resolve(option("--helper", path.join(workspace, "native/updater/target/release/cshift-updater.exe")));
const expectedVersion = option("--expected-version", undefined);
const proxy = option("--proxy", "http://127.0.0.1:7890");
const reportOption = option("--report", undefined);
const reportPath = reportOption ? path.resolve(workspace, reportOption) : undefined;
if (reportPath) {
  const relative = path.relative(workspace, reportPath);
  assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Report must remain in the project directory");
}
const keep = process.argv.includes("--keep");
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "update-service-live-"));
const distribution = path.join(fixture, "distribution");
const target = path.join(distribution, "CDriveShiftAI-live-update.exe");
const data = path.join(distribution, ".cdriveshiftai-data");
const scratch = path.join(fixture, "temp");
const resources = path.join(fixture, "resources");
const statePath = path.join(fixture, "update-observation.json");
const harnessPath = path.join(fixture, "harness.cjs");
let latestVersion, staging;
const runner = path.join(distribution, ".cdriveshiftai-update-runner");
const sentinelPath = path.join(data, "update-sentinel.txt");
const sentinelText = "isolated-settings-index-and-migration-sentinel";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const environment = { ...Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !["TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase()))),
  TEMP: scratch, TMP: scratch, APPDATA: path.join(fixture, "profile/roaming"), LOCALAPPDATA: path.join(fixture, "profile/local"),
  CDRIVESHIFTAI_DATA_DIR: data, PORTABLE_EXECUTABLE_FILE: target,
  PORTABLE_EXECUTABLE_DIR: distribution, CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "14000" };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.CDRIVESHIFTAI_SMOKE_CLOSE_TO_TRAY_AFTER_READY_MS;
const ownedPids = new Set();
let child, childExit, harnessOutput = "", harnessError = "";
let plan, success, launchedWindow, applicationReady, serviceObservation;
let helperLog = "";

function powershell(script, extra = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...environment, ...extra }
  }).trim();
}

function fileVersion(candidate) {
  return powershell("(Get-Item -LiteralPath $env:CSHIFT_VERSION_FILE).VersionInfo.FileVersion", { CSHIFT_VERSION_FILE: candidate });
}

function windowSnapshot(pid) {
  const raw = powershell("$p=Get-Process -Id ([int]$env:CSHIFT_APP_PID) -ErrorAction SilentlyContinue; if($p){[PSCustomObject]@{pid=$p.Id;path=$p.Path;windowHandle=$p.MainWindowHandle.ToInt64();windowTitle=$p.MainWindowTitle}|ConvertTo-Json -Compress}", { CSHIFT_APP_PID: String(pid) });
  return raw ? JSON.parse(raw) : undefined;
}

async function jsonIfPresent(candidate) {
  try { return JSON.parse(await readFile(candidate, "utf8")); } catch { return undefined; }
}

async function readApplicationEvents() {
  const directory = path.join(data, "logs");
  let files;
  try { files = await readdir(directory); } catch { return []; }
  const texts = await Promise.all(files.filter(name => /^main-.*\.jsonl$/.test(name)).map(name => readFile(path.join(directory, name), "utf8")));
  return texts.flatMap(text => text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
}

function safeStopRemainingProcesses() {
  // Identity and fixture-path checks prevent PID reuse from reaching another
  // process. Descendants are included only while rooted under this test folder.
  powershell([
    "$root=[IO.Path]::GetFullPath($env:CSHIFT_FIXTURE_ROOT).TrimEnd('\\')+'\\';",
    "$known=[Collections.Generic.HashSet[int]]::new();foreach($v in ($env:CSHIFT_OWNED_PIDS -split ',')){if($v){$null=$known.Add([int]$v)}};",
    "$all=@(Get-CimInstance Win32_Process);",
    "foreach($item in $all){if($item.ExecutablePath -and [IO.Path]::GetFullPath($item.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){$null=$known.Add([int]$item.ProcessId)}};",
    "foreach($item in $all){if($known.Contains([int]$item.ProcessId) -and $item.ExecutablePath -and [IO.Path]::GetFullPath($item.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){Invoke-CimMethod -InputObject $item -MethodName Terminate -ErrorAction SilentlyContinue|Out-Null}}"
  ].join(""), { CSHIFT_FIXTURE_ROOT: fixture, CSHIFT_OWNED_PIDS: [...ownedPids].join(",") });
}

try {
  for (const directory of [distribution, data, scratch, environment.APPDATA, environment.LOCALAPPDATA, path.join(resources, "bin")]) await mkdir(directory, { recursive: true });
  await copyFile(oldPortable, target);
  await copyFile(helperSource, path.join(resources, "bin/cshift-updater.exe"));
  await writeFile(sentinelPath, sentinelText);
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
    effectMode: "calm", launchAtLogin: false, launchMinimized: false, minimizeToTray: false,
    mouseQuickSearchButton: "disabled", magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: "",
    forceDeleteContextMenu: false, indexRoots: [fixture], ai: { enabled: false }
  } }));
  const oldVersion = fileVersion(target);
  assert.notEqual(oldVersion, expectedVersion, "Use an older disposable portable binary");
  const harness = `
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const data = ${JSON.stringify(data)};
const stateFile = ${JSON.stringify(statePath)};
for(const name of ['session-data','temp','logs','crash-dumps'])fs.mkdirSync(path.join(data,name),{recursive:true});
app.setPath('userData',data);
app.setPath('sessionData',path.join(data,'session-data'));
app.setPath('temp',path.join(data,'temp'));
app.setPath('crashDumps',path.join(data,'crash-dumps'));
app.setAppLogsPath(path.join(data,'logs'));
app.commandLine.appendSwitch('disk-cache-dir',path.join(data,'session-data','cache'));
app.disableHardwareAcceleration();
app.getVersion = () => ${JSON.stringify(oldVersion)};
Object.defineProperty(app,'isPackaged',{value:true});
Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(resources)}});
process.chdir(data); // Reproduce production's data-root working directory.
app.whenReady().then(async()=>{
 await session.defaultSession.setProxy({proxyRules:${JSON.stringify(proxy)}});
 const {configureLogger}=require(${JSON.stringify(path.join(workspace, "dist-electron/logger.js"))});
 configureLogger(data);
 const {UpdateService}=require(${JSON.stringify(path.join(workspace, "dist-electron/update.js"))});
 const observation={oldVersion:app.getVersion(),phases:[],canInstallCalls:0};
 let lastPhase='',lastPercent=-10;
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(observation));
 const service=new UpdateService(state=>{
   observation.state={phase:state.phase,version:state.latestVersion,distribution:state.distribution,message:state.message,errorCode:state.errorCode,network:state.network};
   if(state.phase!==lastPhase){lastPhase=state.phase;observation.phases.push(state.phase);console.log('UPDATE_PHASE '+state.phase);save();}
   const percent=Math.floor((state.progress?.percent??0)/10)*10;
   if(state.phase==='downloading' && percent>=lastPercent+10){lastPercent=percent;console.log('DOWNLOAD '+percent+'%');}
 },async()=>{observation.canInstallCalls++;save();});
 const checked=await service.check(true);
 observation.checked={currentVersion:checked.currentVersion,latestVersion:checked.latestVersion,updateAvailable:checked.updateAvailable,canAutoUpdate:checked.canAutoUpdate,network:checked.network,releaseUrl:checked.releaseUrl,selectedAsset:checked.selectedAsset};save();
 if((${JSON.stringify(expectedVersion)} && checked.latestVersion!==${JSON.stringify(expectedVersion)}) || !checked.updateAvailable || !checked.canAutoUpdate)throw Error('Official latest release is not the expected updatable version: '+checked.message);
 if(!checked.selectedAsset?.downloadUrl.startsWith('https://github.com/PuppetWen/CDriveShiftAI/releases/download/'))throw Error('Unexpected official artifact URL');
 const result=await service.downloadAndInstall();
 observation.finished={phase:result.phase,errorCode:result.errorCode};save();
 if(result.phase!=='installing')throw Error('Update did not hand off: '+result.message);
}).catch(error=>{console.error(error.stack||error);app.exit(1);});
`;
  await writeFile(harnessPath, harness);
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"), [harnessPath], {
    cwd: data, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  ownedPids.add(child.pid);
  childExit = once(child, "exit");
  child.stdout.on("data", chunk => { const text = chunk.toString(); harnessOutput += text; process.stdout.write(text); });
  child.stderr.on("data", chunk => { harnessError += chunk.toString(); });
  const started = Date.now();
  let nextWindowCheck = 0;
  while (Date.now() - started < 8 * 60_000) {
    serviceObservation = await jsonIfPresent(statePath) ?? serviceObservation;
    latestVersion = serviceObservation?.checked?.latestVersion ?? latestVersion;
    if (latestVersion) {
      assert.match(latestVersion, /^\d+\.\d+\.\d+$/, "Unexpected release version");
      staging = path.join(distribution, ".cdriveshiftai-update", latestVersion);
      plan = await jsonIfPresent(path.join(staging, "update-plan.json")) ?? plan;
      success = await jsonIfPresent(path.join(staging, "update-success.json")) ?? success;
      try { helperLog = await readFile(path.join(staging, "update.log"), "utf8"); } catch {}
    }
    const events = await readApplicationEvents();
    const handoff = events.find(event => event.event === "update.install_handoff");
    if (handoff?.fields?.childPid) ownedPids.add(handoff.fields.childPid);
    applicationReady = events.find(event => event.event === "application.ready" && event.fields?.version === latestVersion) ?? applicationReady;
    assert(!events.some(event => ["application.startup_failed", "process.uncaught_exception", "process.unhandled_rejection"].includes(event.event)), "New application reported startup failure");
    if (applicationReady && Date.now() >= nextWindowCheck) {
      ownedPids.add(applicationReady.pid);
      nextWindowCheck = Date.now() + 750;
      const snapshot = windowSnapshot(applicationReady.pid);
      if (snapshot?.windowHandle && /CDriveShiftAI/.test(snapshot.windowTitle)) launchedWindow = snapshot;
    }
    if (child.exitCode !== null && child.exitCode !== 0) throw Error(`Update harness failed (${child.exitCode}): ${harnessError}`);
    if (serviceObservation?.finished?.phase && serviceObservation.finished.phase !== "installing") throw Error(`Service did not install: ${JSON.stringify(serviceObservation.finished)}`);
    if (applicationReady && launchedWindow && success && /reported a successful start/.test(helperLog)) break;
    await wait(150);
  }
  assert(plan, "Real UpdateService did not create its update plan");
  assert(success, "New application did not acknowledge the update");
  assert(applicationReady, "Downloaded application did not initialize");
  assert(launchedWindow, "Downloaded application did not open its main window");
  assert.match(helperLog, /reported a successful start/, "Native helper did not confirm startup");
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0, harnessError);
  assert.equal(plan.parentPid, child.pid, "Helper must wait on the actual old service process");
  assert.equal(path.resolve(plan.targetPath), target, "Updater target escaped the disposable fixture");
  assert.equal(success.version, latestVersion);
  assert.equal(fileVersion(target), latestVersion);
  assert.equal(await readFile(sentinelPath, "utf8"), sentinelText);
  const binary = await readFile(target);
  assert.equal(createHash("sha512").update(binary).digest("hex"), plan.expectedSha512);
  for (const phase of ["checking", "downloading", "verifying", "ready", "installing"]) assert(serviceObservation.phases.includes(phase), `Missing real service phase ${phase}`);
  if (expectedVersion) assert.equal(latestVersion, expectedVersion);
  assert.equal(serviceObservation.checked.selectedAsset.size, (await stat(target)).size);
  // Wait for the downloaded app's test-only timer to close it normally, then
  // allow portable extraction/child processes to release temporary files.
  for (let attempt = 0; attempt < 90; attempt++) {
    const events = await readApplicationEvents();
    if (events.some(event => event.pid === applicationReady.pid && event.event === "application.shutdown_completed")) break;
    await wait(250);
  }
  const finalEvents = await readApplicationEvents();
  assert(finalEvents.some(event => event.pid === applicationReady.pid && event.event === "application.shutdown_completed"), "New app did not complete its timed graceful shutdown");
  assert.equal(await stat(staging).then(() => true, () => false), false, "Updated app left its staging directory behind");
  assert.equal(await stat(runner).then(() => true, () => false), false, "Updated app left its runner directory behind");
  const report = { result: "ok", mode: "official-portable-live-service", beforeVersion: oldVersion, afterVersion: latestVersion,
    actualOfficialDownload: serviceObservation.checked.selectedAsset.downloadUrl,
    proxy: serviceObservation.checked.network?.label, bytes: binary.length,
    phases: serviceObservation.phases, parentExited: true, nativeStartupAcknowledged: true,
    newApplicationReady: true, mainWindowOpened: true, mainWindowTitle: launchedWindow.windowTitle,
    dataSentinelPreserved: true, gracefulShutdown: true, stagingCleaned: true, runnerCleaned: true,
    testingScope: "Real UpdateService and native helper; old packaged metadata is supplied by a disposable Electron harness. The downloaded portable application is unmodified.",
    fixture: keep ? fixture : undefined };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
} catch (error) {
  console.error(JSON.stringify({ result: "failed", fixture: keep ? fixture : undefined,
    serviceObservation, helperLog: helperLog.slice(-8000), harnessError: harnessError.slice(-4000),
    reason: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([childExit, wait(2000)]); }
  safeStopRemainingProcesses();
  if (!keep) {
    assert.equal(path.dirname(path.resolve(fixture)), temporaryRoot);
    assert(path.basename(fixture).startsWith("update-service-live-"));
    await rm(fixture, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
  }
}
