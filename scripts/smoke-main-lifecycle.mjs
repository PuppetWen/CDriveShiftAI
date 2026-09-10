import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Exercise the actual Electron main process/IPC/store with an isolated journal.
// Native hooks/index scans and Windows login registration are replaced so this
// check cannot alter the user's desktop configuration or scan their drives.
const workspace = path.resolve(import.meta.dirname, "..");
const root = path.join(workspace, ".test-tmp");
await mkdir(root, { recursive: true });
const fixture = await mkdtemp(path.join(root, "lifecycle-"));
const data = path.join(fixture, "data");
await mkdir(data);
await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
  launchAtLogin: true, launchMinimized: true, mouseQuickSearchButton: "disabled",
  globalShortcut: "", quickSearchShortcut: ""
} }));
await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "lifecycle-smoke", version: "1.0.0", main: "main.cjs" }));
const harness = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, ipcMain, dialog, globalShortcut } = require("electron");
const handlers = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => { handlers.set(name, handler); originalHandle(name, handler); };
dialog.showErrorBox = (title, content) => { process.stderr.write(title + ": " + content + "\n"); };
app.setLoginItemSettings = (settings) => { global.lastLoginSettings = settings; };
globalShortcut.register = () => true;
const { ExplorerContextMenuService } = require(path.join(process.env.CSHIFT_SMOKE_WORKSPACE, "dist-electron/explorer-context-menu.js"));
let menuEnabled = false, failMenu = false, menuWrites = 0;
ExplorerContextMenuService.prototype.getStatus = async function() {
  return { supported: true, enabled: menuEnabled, registered: menuEnabled, needsRepair: false };
};
ExplorerContextMenuService.prototype.withEnabled = async function(enabled, commit) {
  menuWrites++;
  if (failMenu) { failMenu = false; throw new Error("injected registry access denied"); }
  const previous = menuEnabled;
  menuEnabled = enabled;
  try { return await commit(); } catch (error) { menuEnabled = previous; throw error; }
};
const { SearchService } = require(path.join(process.env.CSHIFT_SMOKE_WORKSPACE, "dist-electron/search.js"));
SearchService.prototype.start = async function() {};
SearchService.prototype.stop = async function() {};
const configure = SearchService.prototype.configureMagnifier;
let concurrent = 0, maximum = 0, fail = false;
SearchService.prototype.configureMagnifier = async function(...args) {
  concurrent++; maximum = Math.max(maximum, concurrent);
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    if (fail) { fail = false; throw new Error("injected native configuration failure"); }
    return await configure.apply(this, args);
  } finally { concurrent--; }
};
require(path.join(process.env.CSHIFT_SMOKE_WORKSPACE, "dist-electron/main.js"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (let i = 0; !handlers.has("settings:update"); i++) { if (i > 300) throw new Error("IPC not ready"); await wait(25); }
  const invoke = (name, ...args) => handlers.get(name)({}, ...args);
  await Promise.all([
    invoke("settings:update", { magnifierWidth: 500, effectMode: "matrix" }),
    invoke("settings:update", { magnifierWidth: 520, uiScale: 1.5 })
  ]);
  assert.equal(maximum, 1, "Runtime settings applied concurrently");
  assert.equal((await invoke("settings:get")).magnifierWidth, 520);
  assert.equal(menuWrites, 0, "Ordinary settings must not modify Explorer registration");
  await assert.rejects(invoke("settings:update", { forceDeleteContextMenu: "true" }), /布尔/);
  assert.equal(menuWrites, 0, "Invalid flags must not reach the registry");
  await invoke("settings:update", { forceDeleteContextMenu: true });
  assert.equal((await invoke("shell:force-delete-menu-status")).enabled, true);
  assert.equal((await invoke("settings:get")).forceDeleteContextMenu, true);
  failMenu = true;
  await assert.rejects(invoke("settings:update", { forceDeleteContextMenu: false }), /registry access denied/);
  assert.equal((await invoke("settings:get")).forceDeleteContextMenu, true);
  assert.equal(menuEnabled, true);
  fail = true;
  await assert.rejects(invoke("settings:update", { forceDeleteContextMenu: false, magnifierWidth: 630 }), /injected native/);
  assert.equal(menuEnabled, true, "Failed runtime update must restore the menu transaction");
  assert.equal((await invoke("settings:get")).forceDeleteContextMenu, true);
  await invoke("settings:update", { forceDeleteContextMenu: false });
  assert.equal(menuEnabled, false);
  fail = true;
  await assert.rejects(invoke("settings:update", { magnifierWidth: 600, effectMode: "ivory" }), /injected native/);
  assert.equal((await invoke("settings:get")).effectMode, "matrix");
  assert.equal((await invoke("settings:get")).magnifierWidth, 520);
  await invoke("settings:update", { launchAtLogin: true, launchMinimized: true });
  assert(global.lastLoginSettings.args.includes(app.getAppPath()), "Development autostart lost its application path");
  assert(global.lastLoginSettings.args.includes("--startup-minimized"));
  await assert.rejects(invoke("settings:update", { globalShortcut: null }), /快捷键/);
  const finalSave = invoke("settings:update", { uiScale: 1.7 });
  app.quit();
  await finalSave;
  process.stdout.write("main-lifecycle-ok\n");
})().catch(error => { process.stderr.write(String(error.stack) + "\n"); app.exit(1); });
`;
await writeFile(path.join(fixture, "main.cjs"), harness);
let child;
let timeout;
try {
  const environment = { ...process.env, CDRIVESHIFTAI_DATA_DIR: data, CSHIFT_SMOKE_WORKSPACE: workspace };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"), [fixture, "--startup-minimized"], {
    env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Main lifecycle timed out")), 25_000); })
  ]);
  assert.equal(code, 0, errors);
  assert.match(output, /main-lifecycle-ok/, errors);
  const state = JSON.parse(await readFile(path.join(data, "cdriveshiftai-state.json"), "utf8"));
  assert.equal(state.settings.uiScale, 1.7, "Quit interrupted pending persistence");
  assert.equal(state.settings.effectMode, "matrix");
  process.stdout.write(JSON.stringify({ result: "ok", serializedRuntimeSettings: true, nativeFailureRollback: true,
    developmentLoginArguments: true, pendingSaveFlushedOnExit: true, isolatedJournal: true }, null, 2) + "\n");
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]); }
  assert(path.resolve(fixture).startsWith(root + path.sep));
  await rm(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}
