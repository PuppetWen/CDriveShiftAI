import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "search-cancellation-"));

// The actual main IPC, isolated preload, renderer and scheduler run together.
// Name and directory-size operations are controlled to reproduce a refresh
// cancelling size work even though the result rows remain identical.
const harness = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, dialog, globalShortcut } = require("electron");
const { setTimeout: wait } = require("node:timers/promises");
const main = path.join(process.env.CSHIFT_SMOKE_WORKSPACE, "dist-electron");
const { SEARCH_SUPERSEDED } = require(path.join(main, "search-scheduler.js"));
const system = require(path.join(main, "system.js"));
system.getLocalDriveRoots = async () => ["E:\\"];
system.getLocalDriveIdentity = async () => "controlled-E-volume";
system.getDriveInfo = async (root) => ({ root, name: "E:", totalBytes: 1_000_000, freeBytes: 900_000,
  usedBytes: 100_000, fileSystem: "NTFS" });
system.isElevated = async () => false;
dialog.showErrorBox = (title, message) => console.error(title + " " + message);
globalShortcut.register = () => true;
app.setLoginItemSettings = () => {};
const { UpdateService } = require(path.join(main, "update.js"));
UpdateService.prototype.check = async function() { return this.getState(); };

const { SearchService } = require(path.join(main, "search.js"));
// Volume replacement has its own regression. This fixture has no native child,
// so focus must not restart its controlled scheduler operations.
SearchService.prototype.refreshDrives = async () => false;
let search;
let releaseFirstSize;
let firstSizeIsCurrent;
let sizeCalls = 0;
let queryCalls = 0;
SearchService.prototype.start = async function() {
  search = this;
  if (this.getStatus().state !== "ready") this.updateStatus({ state: "ready", mode: "native",
    entries: 2, root: "E:\\", progress: 1 });
};
SearchService.prototype.stop = async function() { this.queryScheduler.cancelAll(); };
SearchService.prototype.runSearchPage = async function(query) {
  queryCalls++;
  if (query === "cancel-query") throw new Error(SEARCH_SUPERSEDED);
  if (query === "error-query") throw new Error("fixture-query-failure");
  const name = query === "failure" ? "FailureFolder" : "Documents";
  return { items: [{ name, path: path.join(process.env.CSHIFT_SMOKE_FIXTURE, name), size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z", score: 100, source: "native-index", isDirectory: true }],
    totalMatches: 1, hasMore: false, generation: 1 };
};
SearchService.prototype.runDirectorySizes = async function(paths, isCurrent) {
  sizeCalls++;
  if (sizeCalls === 1) {
    firstSizeIsCurrent = isCurrent;
    await new Promise(resolve => { releaseFirstSize = resolve; });
  }
  if (paths.some(value => value.endsWith("FailureFolder"))) throw new Error("fixture-access-denied");
  return paths.map(location => ({ path: location, bytes: 4096, files: 1, directories: 1, complete: true }));
};
require(path.join(main, "main.js"));
let win;
async function until(predicate, message) {
  for (let attempt = 0; attempt < 140; attempt++) {
    if (await predicate()) return;
    await wait(60);
  }
  throw new Error(message + " | " + JSON.stringify(await win?.webContents.executeJavaScript(
    '({ text: document.querySelector(".results-panel")?.textContent, errors: [...document.querySelectorAll(".toast.error")].map(item => item.textContent) })')));
}
const errors = () => win.webContents.executeJavaScript('[...document.querySelectorAll(".toast.error")].map(item => item.textContent)');
async function query(value) {
  await win.webContents.executeJavaScript('(() => { const input = document.querySelector(".search-keyword-editor > input");' +
    'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ' + JSON.stringify(value) + ');' +
    'input.dispatchEvent(new Event("input", { bubbles: true })); })()');
}
(async () => {
  await until(() => search && (win = BrowserWindow.getAllWindows()[0]), "Main window did not initialize");
  await win.webContents.executeJavaScript('window.cDriveShiftAI.navigateApp({ view: "search", focus: "search-input" })');
  await until(() => releaseFirstSize, "The initial folder-size request did not start");
  const initialQueries = queryCalls;
  win.webContents.send("search:index-changed", { changedCount: 1, generation: 2 });
  await until(() => queryCalls > initialQueries, "Index refresh did not submit another name query");
  assert.equal(firstSizeIsCurrent(), false, "Name query did not cancel the initial size request");
  releaseFirstSize();
  await until(() => win.webContents.executeJavaScript('document.querySelector(".result-size-cell")?.textContent.includes("4.0 KB")'),
    "Equal-result refresh did not resume cancelled folder sizing");
  assert.equal(sizeCalls, 2, "Cancelled sizing should schedule one replacement request");
  assert.deepEqual(await errors(), [], "Expected IPC cancellation displayed an error toast");
  assert.equal(await win.webContents.executeJavaScript('document.body.textContent.includes("搜索暂时不可用")'), false);

  await query("failure");
  await until(async () => (await errors()).some(text => text.includes("fixture-access-denied")), "A genuine folder-size failure was hidden");
  await win.webContents.executeJavaScript('[...document.querySelectorAll(".toast.error button")].forEach(button => button.click())');
  const beforeCancelledQuery = queryCalls;
  await query("cancel-query");
  await until(() => queryCalls > beforeCancelledQuery, "Cancelled query did not run");
  await wait(180);
  assert.equal(await win.webContents.executeJavaScript('document.body.textContent.includes("搜索暂时不可用")'), false,
    "Expected query cancellation displayed search-unavailable state");
  assert.deepEqual(await errors(), []);
  await query("error-query");
  await until(() => win.webContents.executeJavaScript('document.body.textContent.includes("fixture-query-failure")'), "A genuine query error was hidden");
  console.log(JSON.stringify({ result: "ok", realIpcCancellation: true, equalRowsResumeSizes: true,
    cancelledQueryIsSilent: true, genuineSizeAndQueryErrorsVisible: true }));
  app.quit();
})().catch(error => { console.error(error.stack); app.exit(1); });
`;

let child;
let exited;
try {
  const data = path.join(fixture, "data");
  await mkdir(data);
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({
    settings: { language: "zh-CN", effectMode: "calm", launchAtLogin: false, minimizeToTray: false,
      globalShortcut: "", quickSearchShortcut: "", magnifierEnabled: false, mouseQuickSearchButton: "disabled" },
    searchWorkspace: { version: 1, mode: "name", query: "do", filters: { scope: "E:\\", keywordMatch: "any" }, results: [] }
  }));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "search-cancellation-smoke", main: "main.cjs" }));
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
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await Promise.race([exited, wait(35_000, [undefined], { ref: false })]);
  assert.equal(code, 0, stderr || "Search cancellation smoke timed out");
  assert.match(stdout, /"result":"ok"/);
  process.stdout.write(stdout);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([exited, wait(3_000, null, { ref: false })]);
  }
  assert.equal(path.dirname(fixture), tempRoot);
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
