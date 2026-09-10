import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Actual main/preload/renderer routing, with hidden windows and inert deletion,
// registry and native hooks. Never changes the user's Explorer registration.
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "explorer-launch-"));
const data = path.join(fixture, "data");
await mkdir(data);
const first = path.join(fixture, "[中文] a'$(); & first.txt");
const second = path.join(fixture, "second.txt");
const third = path.join(fixture, "third.txt");
for (const file of [first, second, third]) await writeFile(file, "untouched");
await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
  launchAtLogin: true, launchMinimized: true, language: "zh-CN", mouseQuickSearchButton: "disabled",
  magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: ""
} }));
await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "explorer-launch-smoke", version: "1.0.0", main: "main.cjs" }));
await writeFile(path.join(fixture, "main.cjs"), String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, dialog, globalShortcut, ipcMain } = require("electron");
const root = process.env.CSHIFT_SMOKE_WORKSPACE;
const targets = JSON.parse(process.env.CSHIFT_SMOKE_TARGETS);
const load = name => require(path.join(root, "dist-electron", name + ".js"));
BrowserWindow.prototype.show = function() {};
BrowserWindow.prototype.focus = function() {};
dialog.showErrorBox = (title, message) => { process.stderr.write(title + ": " + message + "\n"); };
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
const { SearchService } = load("search");
SearchService.prototype.start = async function() {};
SearchService.prototype.stop = async function() {};
const { ExplorerContextMenuService } = load("explorer-context-menu");
ExplorerContextMenuService.prototype.getStatus = async () => ({ supported: true, enabled: false, registered: false, needsRepair: false });
ExplorerContextMenuService.prototype.withEnabled = async () => { throw new Error("Unexpected registry write"); };
const { ForceDeleteService } = load("force-delete");
const previews = [];
let executions = 0;
ForceDeleteService.prototype.preview = async function(target) {
  assert(targets.includes(target), "The exact selected path must reach the preview");
  previews.push(target);
  return { verificationId: String(previews.length), path: target, name: path.basename(target), isDirectory: false,
    isSymbolicLink: false, highRisk: false, elevated: false, processes: [] };
};
ForceDeleteService.prototype.execute = async function() { executions++; throw new Error("Deletion must never run in launch smoke"); };
const handlers = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => { handlers.set(name, handler); originalHandle(name, handler); };
load("main");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, description) {
  for (let index = 0; index < 300; index++) {
    try { if (await callback()) return; } catch {}
    await wait(50);
  }
  throw new Error("Timed out: " + description);
}
function currentWindow() { return BrowserWindow.getAllWindows().find(win => !win.isDestroyed()); }
const evaluate = code => currentWindow().webContents.executeJavaScript(code);
async function expectTarget(target) {
  await until(async () => await evaluate('document.querySelector(".force-delete-target span")?.textContent === ' + JSON.stringify(target)), target);
  await until(async () => await evaluate('Boolean(document.querySelector(".force-delete-confirmation input"))'), "preview completed");
  assert.equal(await evaluate('document.querySelector(".force-delete-confirmation input").checked'), false);
  assert.equal(await evaluate('document.querySelector(".force-delete-dialog button.danger").disabled'), true);
  assert.equal(await evaluate('document.querySelectorAll(".force-delete-dialog").length'), 1);
}
(async () => {
  await expectTarget(targets[0]);
  assert.deepEqual(await handlers.get("shell:force-delete-requests")({ sender: { id: -1 } }), []);
  app.emit("second-instance", {}, [process.execPath, "--force-delete-path", targets[1]]);
  await wait(200);
  await expectTarget(targets[0]);
  assert.deepEqual(previews, [targets[0]], "A warm launch must not replace the active confirmation");
  await evaluate('document.querySelector(".force-delete-dialog > header > button").click()');
  await expectTarget(targets[1]);
  await evaluate('document.querySelector(".force-delete-dialog > header > button").click()');
  currentWindow().close();
  await until(() => BrowserWindow.getAllWindows().length === 0, "renderer released to tray");
  app.emit("second-instance", {}, [process.execPath, "--force-delete-path", targets[2]]);
  await expectTarget(targets[2]);
  assert.equal(executions, 0);
  assert.deepEqual(previews, targets);
  await evaluate('document.querySelector(".force-delete-dialog > header > button").click()');
  process.stdout.write("explorer-launch-ok\n");
  app.quit();
})().catch(error => { process.stderr.write(String(error.stack) + "\n"); app.exit(1); });
`);
let child, timeout;
try {
  const environment = { ...process.env, CDRIVESHIFTAI_DATA_DIR: data, CSHIFT_SMOKE_WORKSPACE: workspace,
    CSHIFT_SMOKE_TARGETS: JSON.stringify([first, second, third]) };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"),
    [fixture, "--startup-minimized", "--force-delete-path", first],
    { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([once(child, "exit"), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Explorer launch smoke timed out: " + errors)), 55_000);
  })]);
  assert.equal(code, 0, errors);
  assert.match(output, /explorer-launch-ok/);
  for (const file of [first, second, third]) assert.equal(await readFile(file, "utf8"), "untouched");
  console.log(JSON.stringify({ ok: true, coldLaunch: true, warmQueue: true, trayRecreation: true,
    exactUnicodePath: true, confirmationRequired: true, noDeletion: true, noRegistryChanges: true }, null, 2));
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) {
    child.kill(); await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  const relative = path.relative(tempRoot, path.resolve(fixture));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
