import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

// Real Electron, preload, React, search IPC and one native indexer. The native
// initialization is restricted to this test's E-drive files and data directory.
assert.equal(process.platform, "win32");
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "themed-quick-"));
const data = path.join(fixture, "data");
const files = path.join(fixture, "files");
const screenshotIndex = process.argv.indexOf("--screenshot");
const screenshot = screenshotIndex < 0 ? "" : path.resolve(process.argv[screenshotIndex + 1]);
if (screenshot) assert(screenshot.startsWith(workspace + path.sep), "Screenshot must stay inside the project");

const harness = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const childProcess = require("node:child_process");
const { app, BrowserWindow, dialog, globalShortcut, ipcMain } = require("electron");
const { setTimeout: wait } = require("node:timers/promises");
const workspace = process.env.CSHIFT_SMOKE_WORKSPACE;
const fixture = process.env.CSHIFT_SMOKE_FIXTURE;
const main = path.join(workspace, "dist-electron");
const files = path.join(fixture, "files");
const shortcuts = new Map();
globalShortcut.register = (key, callback) => { shortcuts.set(key, callback); return true; };
globalShortcut.isRegistered = key => shortcuts.has(key);
globalShortcut.unregisterAll = () => shortcuts.clear();
app.setLoginItemSettings = () => {};
dialog.showErrorBox = (title, message) => console.error(title + " " + message);
const system = require(path.join(main, "system.js"));
let availableDrives = [files];
system.getLocalDriveRoots = async () => availableDrives;
system.getLocalDriveIdentity = async () => JSON.stringify([...availableDrives].sort());
system.getDriveInfo = async root => ({ root, name: "Test files", totalBytes: 1_000_000, freeBytes: 900_000, usedBytes: 100_000, fileSystem: "NTFS" });
system.isElevated = async () => false;
const { UpdateService } = require(path.join(main, "update.js"));
UpdateService.prototype.check = async function() { return this.getState(); };

const indexerPids = [];
const liveIndexers = new Set();
let maximumLiveIndexers = 0;
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(executable, ...args) {
  assert(!path.basename(executable).startsWith("cshift-quick-search"), "Shortcut launched the prototype UI");
  const child = originalSpawn.call(this, executable, ...args);
  if (path.basename(executable) === "cshift-indexer.exe") {
    indexerPids.push(child.pid);
    liveIndexers.add(child.pid);
    maximumLiveIndexers = Math.max(maximumLiveIndexers, liveIndexers.size);
    child.once("exit", () => liveIndexers.delete(child.pid));
  }
  return child;
};
const { SearchService } = require(path.join(main, "search.js"));
let search;
const services = new Set();
const queries = [];
const originalRequest = SearchService.prototype.requestWithChild;
SearchService.prototype.requestWithChild = function(child, request, timeout) {
  search = this;
  services.add(this);
  if (request.op === "init") {
    // Drive topology is simulated for this renderer/lifecycle test. Keep actual
    // native scans confined to files and let the broker see the simulated roots.
    const indexedRoots = [...availableDrives];
    request = { ...request, root: files, mouseButton: "disabled", magnifierEnabled: false };
    return originalRequest.call(this, child, request, timeout).then(result => ({ ...result, indexedRoots }));
  }
  const pending = originalRequest.call(this, child, request, timeout);
  if (request.op === "query") pending.then(result => queries.push({ query: request.query, scope: request.scopes, results: result.results?.length }), () => undefined);
  return pending;
};

let delayBootstrap = true;
const bootstrapReplies = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => originalHandle(name, async (event, ...args) => {
  let result = await handler(event, ...args);
  if (delayBootstrap && new URL(event.sender.getURL()).searchParams.get("mode") === "quick-search" &&
      ["settings:get", "system:overview", "search:status"].includes(name)) {
    const staleStatus = { mode: "loading", state: "idle", entries: 0, progress: 0, root: files };
    if (name === "system:overview") result = { ...result, indexer: staleStatus };
    if (name === "search:status") result = staleStatus;
    return new Promise(resolve => bootstrapReplies.push(() => resolve(result)));
  }
  return result;
});

require(path.join(main, "main.js"));
const draft = ".search-keyword-editor > input";
const results = '[...document.querySelectorAll(".result-name-cell > strong")].map(node => node.textContent)';
let mainWindow;
let quick;
async function until(predicate, description) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(description + " | " + JSON.stringify({ windows: BrowserWindow.getAllWindows().length, shortcuts: [...shortcuts.keys()], status: search?.getStatus(), indexerPids,
    queries, backgroundMode: search?.backgroundMode, quickText: await quick?.webContents.executeJavaScript('document.body.textContent.slice(-700)') }));
}
function quickWindows() {
  return BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && win.webContents.getURL().includes("mode=quick-search"));
}
async function typingReady(win) {
  await until(() => win.webContents.executeJavaScript('!!document.querySelector(".quick-search-window .search-keyword-editor > input") && document.activeElement === document.querySelector(' + JSON.stringify(draft) + ')'), "Shortcut did not focus the keyword input");
}
async function enterQuery(win, query) {
  win.show();
  win.focus();
  await until(() => win.webContents.executeJavaScript('document.visibilityState === "visible"'), "Search window was not visible for typing");
  await win.webContents.executeJavaScript('(() => { const field = document.querySelector(' + JSON.stringify(draft) + ');' +
    'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ' + JSON.stringify(query) + ');' +
    'field.dispatchEvent(new Event("input", { bubbles: true })); })()');
}
async function matches(win, name) {
  await until(async () => (await win.webContents.executeJavaScript(results)).includes(name), "Search did not display " + name);
}
function invokeShortcut() {
  const callback = shortcuts.get("CommandOrControl+Alt+F");
  assert(callback, "Quick search shortcut was not registered");
  callback();
}

(async () => {
  await until(() => (mainWindow = BrowserWindow.getAllWindows()[0]) && shortcuts.size > 0, "Application failed to initialize");
  mainWindow.show();
  await until(() => search?.getStatus().state === "ready", "Application failed to start a ready shared index");
  const indexer = indexerPids[0];
  assert(indexer);
  invokeShortcut();
  await until(() => (quick = quickWindows()[0]) && bootstrapReplies.length >= 3, "Shortcut failed to create the themed search window");
  await typingReady(quick);
  const quickId = quick.id;
  assert(await quick.webContents.executeJavaScript('!!document.querySelector(".search-filter-workbench-row")'), "Quick window did not reuse the full search filters");
  assert(await quick.webContents.executeJavaScript('!!document.querySelector(".quick-search-effect-switcher")'), "Quick window is missing theme controls");

  await mainWindow.webContents.executeJavaScript('window.cDriveShiftAI.updateSettings({effectMode:"matrix", uiScale:1.2})');
  quick.webContents.send("indexer:status", search.getStatus());
  await until(() => quick.webContents.executeJavaScript('document.documentElement.dataset.effect === "matrix" && document.documentElement.style.getPropertyValue("--text-scale") === "1.2"'), "Quick window did not receive current theme and text scale");
  delayBootstrap = false;
  for (const release of bootstrapReplies) release();
  await wait(120);
  assert.equal(await quick.webContents.executeJavaScript('document.documentElement.dataset.effect'), "matrix", "A stale startup snapshot overwrote the current theme");
  assert.equal(await quick.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--text-scale")'), "1.2");
  assert(await quick.webContents.executeJavaScript('document.querySelector(".quick-search-title-status").textContent.includes("索引") && !document.querySelector(".quick-search-title-status").textContent.includes("准备")'), "A stale startup snapshot overwrote ready status");
  await enterQuery(quick, "theme-fixture");
  await matches(quick, "theme-fixture.txt");
  await mainWindow.webContents.executeJavaScript('window.cDriveShiftAI.navigateApp({view:"search"})');
  await until(() => mainWindow.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(draft) + ')'), "Main search view failed to open");
  await enterQuery(mainWindow, "theme-fixture");
  await matches(mainWindow, "theme-fixture.txt");

  const drivePills = '[...document.querySelectorAll(".drive-scope-pills button")].map(button => button.textContent.trim())';
  availableDrives = [files, "F:\\"];
  quick.emit("focus");
  for (const window of [mainWindow, quick]) window.webContents.send("system:drives-changed");
  for (const window of [mainWindow, quick]) {
    window.show();
    window.focus();
    await until(async () => (await window.webContents.executeJavaScript(drivePills)).includes("F:"), "Drive insertion did not update both search windows");
  }
  await until(() => search.indexedRoots?.includes("F:\\"), "Inserted drive topology did not reach the shared search service");
  availableDrives = [files];
  quick.emit("focus");
  for (const window of [mainWindow, quick]) window.webContents.send("system:drives-changed");
  for (const window of [mainWindow, quick]) {
    window.show();
    window.focus();
    await until(async () => !(await window.webContents.executeJavaScript(drivePills)).includes("F:"), "Drive removal left a stale search location");
  }
  await until(() => search.indexedRoots?.length === 1, "Removed drive topology did not reach the shared search service");
  availableDrives = [files, "G:\\"];
  quick.emit("focus");
  for (const window of [mainWindow, quick]) await window.webContents.executeJavaScript('window.dispatchEvent(new Event("focus"))');
  for (const window of [mainWindow, quick]) {
    window.show();
    window.focus();
    await until(async () => (await window.webContents.executeJavaScript(drivePills)).includes("G:"), "Refocusing did not recover a changed drive list");
  }
  await until(() => search.indexedRoots?.includes("G:\\"), "Refocusing did not refresh the shared search topology");
  availableDrives = [files];
  quick.emit("focus");
  for (const window of [mainWindow, quick]) window.webContents.send("system:drives-changed");

  await quick.webContents.executeJavaScript('document.querySelector(".quick-search-effect-switcher button").focus()');
  invokeShortcut();
  await typingReady(quick);
  assert.equal(quickWindows().length, 1, "Repeated shortcut created duplicate windows");
  assert.equal(quick.id, quickId);
  quick.minimize();
  await until(() => quick.isMinimized(), "Quick window did not minimize");
  invokeShortcut();
  await until(() => !quick.isMinimized() && quick.isVisible(), "Shortcut failed to restore the minimized quick window");
  await typingReady(quick);
  quick.close();
  await until(() => quick.isDestroyed(), "Closing quick search did not release its renderer");
  invokeShortcut();
  await until(() => (quick = quickWindows()[0]) && quick.isVisible(), "Shortcut failed to reopen quick search");
  await typingReady(quick);
  assert.notEqual(quick.id, quickId);
  await until(() => quick.webContents.executeJavaScript('document.documentElement.dataset.effect === "matrix"'), "Reopened window lost the current theme");
  await enterQuery(quick, "theme-fixture");
  await matches(quick, "theme-fixture.txt");
  assert.equal(maximumLiveIndexers, 1, "Drive changes started overlapping native index processes");
  assert(indexerPids.length > 1, "Simulated drive changes did not exercise native restarts");
  assert.equal(services.size, 1, "Quick search created another search service");
  if (process.env.CSHIFT_SMOKE_SCREENSHOT) {
    await wait(900);
    await fs.writeFile(process.env.CSHIFT_SMOKE_SCREENSHOT, (await quick.webContents.capturePage()).toPNG());
  }
  console.log(JSON.stringify({result:"ok", shortcutUsesThemedUi:true, settingsRaceHandled:true, keywordFocus:true,
    minimizedRestore:true, closeAndReopen:true, sharedSearchService:true, searchResults:true, driveChangesRefresh:true,
    maximumLiveIndexers, simulatedTopologyRestarts:indexerPids.length - 1}));
  app.quit();
})().catch(error => { console.error(error.stack); app.exit(1); });
`;

let child;
let exited;
try {
  await mkdir(data);
  await mkdir(files);
  await writeFile(path.join(files, "theme-fixture.txt"), "Themed quick search fixture\n");
  await writeFile(path.join(files, "other-document.txt"), "Other fixture\n");
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
    language: "zh-CN", effectMode: "aurora", uiScale: 1, launchAtLogin: false, minimizeToTray: false,
    globalShortcut: "CommandOrControl+Alt+Space", quickSearchShortcut: "CommandOrControl+Alt+F",
    mouseQuickSearchButton: "disabled", magnifierEnabled: false
  } }));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "themed-quick-smoke", main: "main.cjs" }));
  await writeFile(path.join(fixture, "main.cjs"), harness);
  const env = { ...process.env, TEMP: fixture, TMP: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
    CDRIVESHIFTAI_DATA_DIR: data, CSHIFT_SMOKE_WORKSPACE: workspace, CSHIFT_SMOKE_FIXTURE: fixture, CSHIFT_SMOKE_SCREENSHOT: screenshot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"), [fixture], {
    cwd: fixture, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([exited, wait(45_000, [undefined], { ref: false })]);
  if (code !== 0) errors += await readFile(path.join(data, "logs", `main-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").catch(() => "");
  assert.equal(code, 0, errors || "Themed quick search smoke timed out");
  assert.match(output, /"result":"ok"/);
  const logs = await readFile(path.join(data, "logs", `main-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  assert((logs.match(/"event":"indexer\.spawn_requested"/g)?.length ?? 0) > 1);
  assert.match(logs, /"event":"application\.shutdown_completed"/);
  console.log(output.trim());
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, timeout: 8000
    }).catch(() => child.kill());
    await exited;
  }
  assert.equal(path.dirname(fixture), tempRoot);
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
