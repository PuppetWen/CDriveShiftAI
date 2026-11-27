import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

assert.equal(process.platform, "win32");
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "search-scope-startup-"));

// Drive letters and native index readiness are controlled. The browser, preload,
// main IPC, live search, and on-disk file metadata are real. Run after build:main and build:web.
const harness = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, dialog, globalShortcut } = require("electron");
const { setTimeout: wait } = require("node:timers/promises");
const workspace = process.env.CSHIFT_SMOKE_WORKSPACE;
const fixture = process.env.CSHIFT_SMOKE_FIXTURE;
const downloads = "C:\\Users\\Lenovo\\Downloads";
const packageDirectory = path.join(downloads, "CEV-Windows-x64-P2P-Test-Portable");
const driveC = "C:\\";
const driveE = "E:\\";
const diskFiles = [path.join(packageDirectory, "CEV.exe"), path.join(packageDirectory, "CEV-notes.txt"),
  "C:\\Elsewhere\\CEV-Other.exe", "E:\\Backup\\CEV-Backup.exe"];
const deferredPath = path.join(packageDirectory, "Ready-Only.exe");
const saveFile = fs.writeFile;
const openedFolders = [];

function fixturePath(target) {
  if (typeof target !== "string" || !/^[CE]:/i.test(target)) return target;
  const normalized = target.toLowerCase();
  const base = workspace.toLowerCase();
  if (normalized === base || normalized.startsWith(base + "\\")) return target;
  return path.join(fixture, "volumes", target[0].toUpperCase(), target.slice(3));
}

for (const method of ["access", "lstat", "opendir", "readdir", "realpath", "stat"]) {
  const call = fs[method];
  fs[method] = (target, ...options) => {
    if (method === "readdir" && (target === downloads || target === driveC)) openedFolders.push(target);
    return call(fixturePath(target), ...options);
  };
}
const main = path.join(workspace, "dist-electron");
const system = require(path.join(main, "system.js"));
system.getLocalDriveRoots = async () => [driveC, driveE];
system.getLocalDriveIdentity = async () => "controlled-C-and-E-volumes";
system.getDriveInfo = async (root) => ({ root, name: root.slice(0, 2), totalBytes: 1_000_000,
  freeBytes: 900_000, usedBytes: 100_000, fileSystem: "NTFS" });
system.isElevated = async () => false;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [downloads] });
dialog.showErrorBox = (title, message) => console.error(title + " " + message);
globalShortcut.register = () => true;
app.setLoginItemSettings = () => {};
const getAppPath = app.getPath.bind(app);
app.getPath = (key) => key === "downloads" ? downloads : getAppPath(key);
const { UpdateService } = require(path.join(main, "update.js"));
UpdateService.prototype.check = async function() { return this.getState(); };

const { SearchService } = require(path.join(main, "search.js"));
SearchService.prototype.refreshDrives = async () => false;
let search;
let ready = false;
const calls = [];
const originalSearchPage = SearchService.prototype.searchPage;
SearchService.prototype.searchPage = function(query, filters, ...rest) {
  calls.push({ query, scope: filters.scope, scopes: filters.scopes ?? [] });
  return originalSearchPage.call(this, query, filters, ...rest);
};
SearchService.prototype.start = async function() {
  search = this;
  this.child = { exitCode: 0 };
};
SearchService.prototype.stop = async function() {};
SearchService.prototype.request = async function(request) {
  if (request.op !== "query") return { ok: true };
  const results = [];
  if (ready) {
    for (const location of [...diskFiles, deferredPath]) {
      const name = path.basename(location);
      if (!name.toLowerCase().includes(request.query.toLowerCase())) continue;
      if (request.categories?.includes("executable") && path.extname(name) !== ".exe") continue;
      const scopes = request.scopes?.length ? request.scopes : [request.scope];
      if (!scopes.some((scope) => scope === "*" || location.toLowerCase().startsWith(scope.toLowerCase().replace(/\\?$/, "\\")))) continue;
      results.push({ name, path: location, size: 1, score: 100, source: "native-index", isDirectory: false });
    }
  }
  return { ok: true, results, hasMore: false, totalMatches: results.length, generation: ready ? 2 : 0 };
};

require(path.join(main, "main.js"));
const names = '[...document.querySelectorAll(".result-name-cell > strong")].map(node => node.textContent).sort()';
const draft = ".search-keyword-editor > input";
let win;
async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await wait(80);
  }
  throw Error(description + ": " + JSON.stringify(await win?.webContents.executeJavaScript(names)) + " | " + JSON.stringify(calls.slice(-4)));
}
async function showResults(expected, description) {
  await until(async () => JSON.stringify(await win.webContents.executeJavaScript(names)) === JSON.stringify([...expected].sort()), description);
}
async function pick(selector) {
  await win.webContents.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click()');
}
async function enterQuery(query) {
  await win.webContents.executeJavaScript('(() => { const field = document.querySelector(' + JSON.stringify(draft) + ');' +
    'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ' + JSON.stringify(query) + ');' +
    'field.dispatchEvent(new Event("input", { bubbles: true })); })()');
}

(async () => {
  await until(() => search && (win = BrowserWindow.getAllWindows()[0]), "Application failed to initialize");
  await win.webContents.executeJavaScript('window.cDriveShiftAI.navigateApp({view:"search", focus:"search-input"})');
  await until(() => win.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(draft) + ')'), "Search view failed to load");
  await showResults(["CEV.exe", "CEV-Other.exe"], "Cold C: search lost a Downloads match, ignored the executable category, or leaked another drive");
  assert(calls.some((call) => call.query === "CEV" && call.scope === driveC));
  assert.equal(openedFolders[0], downloads, "Search must prioritize Downloads over a broad drive scan");

  await pick(".search-filter-location .scope-button");
  await showResults(["CEV.exe"], "Cold directory search escaped its chosen folder");
  assert(calls.some((call) => call.scope === downloads));
  await pick(".drive-scope-pills button:nth-child(3)");
  await showResults(["CEV-Backup.exe", "CEV.exe"], "Cold multi-scope search did not combine two locations");
  assert.deepEqual(calls.at(-1).scopes, [downloads, driveE]);

  await pick(".search-filter-location .scope-button");
  await enterQuery("Ready-Only");
  await until(() => win.webContents.executeJavaScript('document.body.textContent.includes("当前还没有可显示的结果")'), "Incomplete search displayed a definitive miss");
  const readyRequests = calls.length;
  await saveFile(fixturePath(deferredPath), "exists once the name index becomes ready\n");
  ready = true;
  search.updateStatus({ state: "ready", mode: "native", entries: 5, root: "*", progress: 100 });
  await showResults(["Ready-Only.exe"], "Search did not rerun after readiness without an index-change event");
  assert(calls.length > readyRequests);
  assert.equal(calls.at(-1).scope, downloads);

  await enterQuery("CEV");
  await showResults(["CEV.exe"], "Ready directory search escaped its chosen folder");
  await pick(".drive-scope-pills button:nth-child(3)");
  await showResults(["CEV-Backup.exe", "CEV.exe"], "Ready multi-scope search did not combine both locations");
  await pick(".drive-scope-pills button:first-child");
  await showResults(["CEV-Backup.exe", "CEV-Other.exe", "CEV.exe"], "Global search missed scoped results");
  await pick(".drive-scope-pills button:nth-child(2)");
  await showResults(["CEV-Other.exe", "CEV.exe"], "Ready C: search leaked another drive");
  await enterQuery("AbsolutelyMissing");
  await until(() => win.webContents.executeJavaScript('document.body.textContent.includes("没有找到匹配项")'), "Completed search did not display a definitive miss");
  console.log(JSON.stringify({result:"ok", coldDriveAndDownloads:true, folderAndMultiScope:true, statusOnlyRefresh:true, readyGlobalParity:true}));
  app.quit();
})().catch((error) => { console.error(error.stack); app.exit(1); });
`;

let child;
let exited;
try {
  for (const [volume, directory, names] of [
    ["C", "Users/Lenovo/Downloads/CEV-Windows-x64-P2P-Test-Portable", ["CEV.exe", "CEV-notes.txt"]],
    ["C", "Elsewhere", ["CEV-Other.exe"]],
    ["E", "Backup", ["CEV-Backup.exe"]]
  ]) {
    const folder = path.join(fixture, "volumes", volume, directory);
    await mkdir(folder, { recursive: true });
    for (const name of names) await writeFile(path.join(folder, name), "Search fixture\n");
  }
  const data = path.join(fixture, "data");
  await mkdir(data);
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({
    settings: { language: "zh-CN", effectMode: "calm", offlineMode: true, launchAtLogin: false, minimizeToTray: false,
      globalShortcut: "", quickSearchShortcut: "", magnifierEnabled: false, mouseQuickSearchButton: "disabled" },
    searchWorkspace: { version: 1, mode: "name", query: "CEV", filterPanelOpen: true,
      filters: { scope: "C:\\", scopes: ["C:\\"], categories: ["executable"], keywordMatch: "any" }, results: [] }
  }));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "search-scope-startup-smoke", main: "main.cjs" }));
  await writeFile(path.join(fixture, "main.cjs"), harness);
  const env = { ...process.env, TEMP: fixture, TMP: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
    CDRIVESHIFTAI_DATA_DIR: data, CSHIFT_SMOKE_FIXTURE: fixture, CSHIFT_SMOKE_WORKSPACE: workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"), [fixture], {
    cwd: fixture, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await Promise.race([exited, wait(40_000, [undefined], { ref: false })]);
  assert.equal(code, 0, stderr || "Search scope smoke timed out");
  assert.match(stdout, /"result":"ok"/);
  process.stdout.write(stdout);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([exited, wait(5_000, null, { ref: false })]);
  }
  assert.equal(path.dirname(fixture), tempRoot);
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
