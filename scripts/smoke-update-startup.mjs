import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Run production main/window loading and the update acknowledgement in real
// Electron. Only scans, global shortcuts, login/Explorer registration and
// network update checks are replaced; no installer or user data is accessed.
const workspace = path.resolve(import.meta.dirname, "..");
const root = path.join(workspace, ".test-tmp");
await mkdir(root, { recursive: true });
const fixture = await mkdtemp(path.join(root, "update-startup-"));
const temporary = path.join(fixture, "temp");
const data = path.join(fixture, "data");
const compiled = path.join(fixture, "dist-electron");
const staging = path.join(fixture, ".cdriveshiftai-update", "0.0.1");
const marker = path.join(staging, "update-success.json");
const report = path.join(fixture, "report.json");
const environment = {
  ...process.env, TEMP: temporary, TMP: temporary,
  APPDATA: path.join(fixture, "appdata"), LOCALAPPDATA: path.join(fixture, "localappdata"),
  CDRIVESHIFTAI_DATA_DIR: data,
  PORTABLE_EXECUTABLE_FILE: path.join(fixture, "CDriveShiftAI.exe")
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VITE_DEV_SERVER_URL;
let child;
let timeout;
try {
  for (const directory of [temporary, data, staging, environment.APPDATA, environment.LOCALAPPDATA]) {
    await mkdir(directory, { recursive: true });
  }
  const build = spawnSync(process.execPath, [path.join(workspace, "node_modules/typescript/bin/tsc"),
    "-p", path.join(workspace, "tsconfig.electron.json"), "--outDir", compiled], {
    cwd: workspace, env: environment, windowsHide: true, encoding: "utf8"
  });
  assert.equal(build.status, 0, build.stderr || build.stdout || "Electron compile failed");
  await cp(path.join(workspace, "dist"), path.join(fixture, "dist"), { recursive: true });
  await mkdir(path.join(fixture, "build"));
  await cp(path.join(workspace, "build/icon.png"), path.join(fixture, "build/icon.png"));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "update-startup-smoke", version: "0.0.1", main: "main.cjs" }));
  await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
    launchAtLogin: false, launchMinimized: true, minimizeToTray: false,
    mouseQuickSearchButton: "disabled", magnifierEnabled: false,
    globalShortcut: "", quickSearchShortcut: "", forceDeleteContextMenu: false,
    indexRoots: [fixture], ai: { enabled: false }
  } }));
  await writeFile(path.join(staging, "update-plan.json"), JSON.stringify({
    schemaVersion: 1, stagingDir: staging, expectedVersion: "0.0.1", successMarker: marker
  }));
  await writeFile(path.join(fixture, "main.cjs"), String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, globalShortcut } = require("electron");
const fixture = __dirname;
const compiled = path.join(fixture, "dist-electron");
const marker = path.join(fixture, ".cdriveshiftai-update", "0.0.1", "update-success.json");
const report = { electron: process.versions.electron, events: [], checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(path.join(fixture, "report.json"), JSON.stringify(report, null, 2));
app.commandLine.appendSwitch("disk-cache-dir", path.join(fixture, "data/session-data/cache"));
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
dialog.showErrorBox = (title, content) => { throw new Error(title + ": " + content); };
const { ExplorerContextMenuService } = require(path.join(compiled, "explorer-context-menu.js"));
ExplorerContextMenuService.prototype.getStatus = async () => ({ supported: true, enabled: false, registered: false, needsRepair: false });
ExplorerContextMenuService.prototype.withEnabled = async () => { throw new Error("Registry mutation is forbidden in startup smoke"); };
const { SearchService } = require(path.join(compiled, "search.js"));
SearchService.prototype.start = async () => {};
SearchService.prototype.stop = async () => {};
const { UpdateService } = require(path.join(compiled, "update.js"));
UpdateService.prototype.check = async function() { return this.getState(); };
const { waitForVisibleUpdateWindow, isVisibleUpdateWindow } = require(path.join(compiled, "update-startup.js"));
let mainWindow;
app.once("browser-window-created", (_event, window) => {
  mainWindow = window;
  const capture = event => {
    report.events.push({ event, visible: window.isVisible(), loading: window.webContents.isLoadingMainFrame() });
    save();
  };
  for (const event of ["show", "ready-to-show"]) window.on(event, () => capture(event));
  for (const event of ["did-start-loading", "dom-ready", "did-finish-load", "did-stop-loading"]) {
    window.webContents.on(event, () => capture(event));
  }
});
require(path.join(compiled, "main.js"));
(async () => {
  const deadline = Date.now() + 12_000;
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("Visible production main window did not acknowledge startup: " + JSON.stringify({
      events: report.events, final: mainWindow && { visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized(),
        loading: mainWindow.webContents.isLoadingMainFrame(), url: mainWindow.webContents.getURL() }
    }));
    await wait(25);
  }
  assert(mainWindow && isVisibleUpdateWindow(mainWindow));
  assert(report.events.some(item => item.event === "did-finish-load"));
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).version, "0.0.1");
  assert.equal(await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.childElementCount)"), true,
    "The production renderer did not render its main view");
  report.checks.push("production main window loaded, rendered, visible and acknowledged");

  const hidden = new BrowserWindow({ show: false, width: 420, height: 240, webPreferences: { sandbox: true } });
  let acknowledged = false;
  const hiddenReady = waitForVisibleUpdateWindow(hidden, 3000).then(() => { acknowledged = true; });
  await hidden.loadURL("data:text/html,<title>Delayed visibility</title><p>Ready</p>");
  await wait(50);
  assert.equal(acknowledged, false, "Hidden loaded windows must not acknowledge");
  hidden.show();
  await hiddenReady;
  hidden.destroy();
  report.checks.push("finish before show waits for actual visibility");

  const failed = new BrowserWindow({ show: false, width: 420, height: 240, webPreferences: { sandbox: true } });
  const failedReady = assert.rejects(waitForVisibleUpdateWindow(failed, 3000), /failed to load/);
  failed.show();
  await failed.loadFile(path.join(fixture, "missing-renderer.html")).catch(() => {});
  await failedReady;
  failed.destroy();
  report.checks.push("real renderer load failure rejects acknowledgement");

  const closed = new BrowserWindow({ show: false, width: 420, height: 240, webPreferences: { sandbox: true } });
  const closedReady = assert.rejects(waitForVisibleUpdateWindow(closed, 3000), /before startup acknowledgement/);
  closed.close();
  await closedReady;
  report.checks.push("window closed before load rejects acknowledgement");
  const cleanupDeadline = Date.now() + 7000;
  while (fs.existsSync(path.dirname(marker))) {
    if (Date.now() > cleanupDeadline) throw new Error("Production update acknowledgement did not clean its staging directory");
    await wait(50);
  }
  assert(isVisibleUpdateWindow(mainWindow), "Main window must remain open after update cleanup");
  report.checks.push("production completePendingUpdate marker and staging cleanup completed with main window still visible");
  save();
  process.stdout.write("update-startup-ok\n");
  app.quit();
})().catch(error => { report.error = error.stack; save(); process.stderr.write(String(error.stack) + "\n"); app.exit(1); });
`);
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"),
    [fixture, "--updated", "--update-staging", staging, "--startup-minimized", `--user-data-dir=${data}`], {
      // This intentionally opens a GUI window. SW_HIDE on process startup can
      // override Electron's first ShowWindow call and invalidate visibility.
      cwd: fixture, env: environment, windowsHide: false, stdio: ["ignore", "pipe", "pipe"]
    });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Electron startup smoke timed out")), 25_000); })
  ]);
  const observation = JSON.parse(await readFile(report, "utf8"));
  assert.equal(code, 0, observation.error || errors);
  assert.match(output, /update-startup-ok/, errors);
  process.stdout.write(JSON.stringify({ result: "ok", ...observation }, null, 2) + "\n");
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  assert(path.resolve(fixture).startsWith(root + path.sep));
  await rm(fixture, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
