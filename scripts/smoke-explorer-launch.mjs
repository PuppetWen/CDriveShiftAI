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
const second = path.join(fixture, "模型动作 动作 $(); & test");
const third = path.join(fixture, "third.txt");
const fourth = path.join(fixture, "simulated-success.txt");
await mkdir(second);
for (const file of [first, path.join(second, "keep.txt"), third, fourth]) await writeFile(file, "untouched");
await writeFile(path.join(data, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
  launchAtLogin: true, launchMinimized: true, language: "zh-CN", mouseQuickSearchButton: "disabled",
  magnifierEnabled: false, globalShortcut: "", quickSearchShortcut: "", effectMode: "calm"
} }));
await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "explorer-launch-smoke", version: "1.0.0", main: "main.cjs" }));
await writeFile(path.join(fixture, "main.cjs"), String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { app, BrowserWindow, dialog, globalShortcut, ipcMain } = require("electron");
const root = process.env.CSHIFT_SMOKE_WORKSPACE;
const targets = JSON.parse(process.env.CSHIFT_SMOKE_TARGETS);
const load = name => require(path.join(root, "dist-electron", name + ".js"));
const visibilityCalls = [];
const createdWindowIds = [];
app.on("browser-window-created", (_event, window) => {
  createdWindowIds.push(window.id);
  window.webContents.setBackgroundThrottling(false);
});
for (const method of ["show", "showInactive", "focus", "restore"]) {
  BrowserWindow.prototype[method] = function() { visibilityCalls.push({ id: this.id, method }); };
}
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
let executionBusy = false;
ForceDeleteService.prototype.preview = async function(target) {
  assert(targets.includes(target), "The exact selected path must reach the preview");
  previews.push(target);
  return { verificationId: String(previews.length), path: target, name: path.basename(target), isDirectory: target === targets[1],
    isSymbolicLink: false, highRisk: false, elevated: false, processes: [] };
};
ForceDeleteService.prototype.isBusy = function() { return executionBusy; };
ForceDeleteService.prototype.execute = async function(verificationId) {
  assert.equal(previews[Number(verificationId) - 1], targets[3], "Only the explicitly confirmed simulation may reach execution");
  executions++;
  executionBusy = true;
  try { await wait(600); return { deleted: true, terminatedProcesses: [] }; }
  finally { executionBusy = false; }
};
const handlers = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain);
let delayNextRequest = false;
let delayedRequestCaptured = false;
let releaseDelayedRequest;
ipcMain.handle = (name, handler) => {
  handlers.set(name, handler);
  originalHandle(name, async (...args) => {
    const value = await handler(...args);
    if (name === "shell:force-delete-requests" && delayNextRequest && Array.isArray(value) && value.length) {
      delayNextRequest = false;
      delayedRequestCaptured = true;
      await new Promise(resolve => { releaseDelayedRequest = resolve; });
    }
    return value;
  });
};
const launches = [];
app.on("second-instance", (_event, argv, _directory, additionalData) => { launches.push({ argv, additionalData }); });
load("main");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, description) {
  for (let index = 0; index < 300; index++) {
    try { if (await callback()) return; } catch {}
    await wait(50);
  }
  throw new Error("Timed out: " + description);
}
function liveWindows() { return BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()); }
function isConfirmationWindow(window) {
  const url = window.webContents.getURL();
  return url && new URL(url).searchParams.get("mode") === "force-delete";
}
function currentWindow() { return liveWindows().find(isConfirmationWindow); }
function currentMainWindow() { return liveWindows().find(window => !isConfirmationWindow(window)); }
const evaluate = code => currentWindow().webContents.executeJavaScript(code);
async function expectTarget(target) {
  await until(async () => await evaluate('document.querySelector(".force-delete-target span")?.textContent === ' + JSON.stringify(target)), target);
  await until(async () => await evaluate('Boolean(document.querySelector(".force-delete-confirmation input"))'), "preview completed");
  assert.equal(await evaluate('document.querySelector(".force-delete-confirmation input").checked'), false);
  assert.equal(await evaluate('document.querySelector(".force-delete-dialog button.danger").disabled'), true);
  assert.equal(await evaluate('document.querySelectorAll(".force-delete-dialog").length'), 1);
  assert.equal(await evaluate('document.querySelector(".app-shell, .side-nav, .main-stage")'), null, "Explorer confirmation must not mount the application interface");
  assert.equal(currentWindow().getParentWindow(), null, "Explorer confirmation must be an independent window");
  assert.equal(await evaluate('document.querySelector(".force-delete-confirmation").dataset.confirmed'), "false");
  assert.match(await evaluate('document.querySelector("#force-delete-status")?.textContent || ""'), /勾选/);
}
async function clickConfirmationRow(expected) {
  const executionsBefore = executions;
  const position = await evaluate('(() => { const row = document.querySelector(".force-delete-confirmation"); row.scrollIntoView({block: "center"}); const text = row.querySelector("strong"); const box = text.getBoundingClientRect(); const x = Math.round(box.left + box.width / 2); const y = Math.round(box.top + box.height / 2); const hit = document.elementFromPoint(x, y); const input = row.querySelector("input"); const style = getComputedStyle(input); const inputBox = input.getBoundingClientRect(); return { x, y, hit: row.contains(hit), opacity: style.opacity, pointerEvents: style.pointerEvents, width: inputBox.width, height: inputBox.height }; })()');
  assert.equal(position.hit, true, "The consent text must be reachable without an overlay intercepting clicks");
  assert.equal(position.opacity, "1", "The consent checkbox must not inherit hidden settings-switch styles");
  assert.notEqual(position.pointerEvents, "none");
  assert(position.width >= 18 && position.height >= 18, "The consent checkbox needs a visible hit area");
  const window = currentWindow();
  window.webContents.sendInputEvent({ type: "mouseMove", x: position.x, y: position.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: position.x, y: position.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: position.x, y: position.y, button: "left", clickCount: 1 });
  await until(async () => await evaluate('document.querySelector(".force-delete-confirmation input").checked === ' + JSON.stringify(expected)), "consent row mouse click");
  assert.equal(await evaluate('document.querySelector(".force-delete-confirmation").dataset.confirmed'), String(expected));
  assert.equal(await evaluate('document.querySelector(".force-delete-dialog button.danger").disabled'), !expected);
  assert.match(await evaluate('document.querySelector(".force-delete-confirmation-copy strong").textContent'), expected ? /已勾选/ : /点击勾选/);
  assert.equal(executions, executionsBefore, "Consent must never execute deletion by itself");
}
async function cancelDialog() {
  // Closing the renderer can destroy its evaluation result channel. Observe
  // window lifecycle separately instead of awaiting a response from that page.
  void evaluate('document.querySelector(".force-delete-dialog footer button:not(.danger)").click()').catch(() => {});
}
async function capture(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await wait(150);
  const bounds = await evaluate('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth })');
  assert(bounds.scrollWidth <= bounds.width + 1 && bounds.bodyWidth <= bounds.width + 1, "Standalone surface must not overflow horizontally: " + JSON.stringify(bounds));
  const screenshotDirectory = path.join(root, "review-artifacts");
  await require("node:fs/promises").mkdir(screenshotDirectory, { recursive: true });
  await require("node:fs/promises").writeFile(path.join(screenshotDirectory, name), (await currentWindow().webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
async function launchSecond(target) {
  const child = spawn(process.execPath, [app.getAppPath(), "--force-delete-path", target], {
    env: { ...process.env, CSHIFT_SMOKE_SECOND_INSTANCE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  let timer;
  try {
    const [code] = await Promise.race([once(child, "exit"), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Secondary Electron process did not exit: " + errors)), 15000);
    })]);
    assert.equal(code, 0, errors);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
(async () => {
  if (process.env.CSHIFT_SMOKE_SECOND_INSTANCE === "1") return;
  process.stdout.write("checking-cold-confirmation\n");
  await expectTarget(targets[0]);
  assert.equal(liveWindows().length, 1, "Cold Explorer launch must create only the standalone confirmation");
  assert.equal(createdWindowIds.length, 1, "The main window must not be created and hidden during cold launch");
  await until(async () => await evaluate('document.documentElement.dataset.effect === "calm"'), "light appearance applied");
  await capture("standalone-force-delete.png");
  assert.deepEqual(await handlers.get("shell:force-delete-requests")({ sender: { id: -1 } }), []);
  await clickConfirmationRow(true);
  await capture("standalone-force-delete-confirmed.png");
  process.stdout.write("checking-warm-confirmation-queue\n");
  await launchSecond(targets[1]);
  await wait(200);
  assert.equal(await evaluate('document.querySelector(".force-delete-target span").textContent'), targets[0]);
  assert.equal(await evaluate('document.querySelector(".force-delete-confirmation input").checked'), true);
  assert.deepEqual(previews, [targets[0]], "A warm launch must not replace the active confirmation");
  await evaluate('document.querySelector(".force-delete-dialog > header > button").click()');
  await expectTarget(targets[1]);
  await cancelDialog();
  await until(() => liveWindows().length === 0, "last cancellation closes the standalone window");
  await launchSecond(targets[2]);
  await expectTarget(targets[2]);
  assert.equal(liveWindows().length, 1, "A tray launch must not recreate the application interface");
  currentWindow().close();
  await until(() => liveWindows().length === 0, "native window close cancels the preview");
  process.stdout.write("checking-existing-main-window\n");

  // Open the ordinary application explicitly, then prove an Explorer request
  // leaves that window and its renderer untouched while opening a separate one.
  app.emit("activate");
  await until(async () => currentMainWindow() && await currentMainWindow().webContents.executeJavaScript('Boolean(document.querySelector(".app-shell"))'), "ordinary application window");
  const main = currentMainWindow();
  await wait(250);
  const mainCallsBefore = visibilityCalls.filter(item => item.id === main.id);
  await launchSecond(targets[0]);
  await expectTarget(targets[0]);
  assert.equal(liveWindows().length, 2);
  assert.equal(currentMainWindow().id, main.id);
  assert.deepEqual(visibilityCalls.filter(item => item.id === main.id), mainCallsBefore, "Explorer launch must not show, restore or focus the existing main window");
  assert.equal(await main.webContents.executeJavaScript('document.querySelectorAll(".force-delete-dialog").length'), 0, "The existing main renderer must not receive the Explorer confirmation");
  assert.deepEqual(await handlers.get("shell:force-delete-requests")({ sender: main.webContents }), [], "Only the standalone renderer can consume Explorer requests");
  await clickConfirmationRow(true);
  await clickConfirmationRow(false);
  await cancelDialog();
  await until(() => liveWindows().length === 1 && currentMainWindow()?.id === main.id, "cancel retains the existing application window");
  main.close();
  await until(() => liveWindows().length === 0, "application renderer released to tray");
  await launchSecond(targets[1]);
  await expectTarget(targets[1]);
  assert.equal(liveWindows().length, 1);
  // The main queue has already been drained, but delivery to the renderer is
  // paused. Cancel must preserve the incoming request instead of closing it.
  delayNextRequest = true;
  await launchSecond(targets[2]);
  await until(() => delayedRequestCaptured, "incoming request drained but IPC response paused");
  await cancelDialog();
  await wait(150);
  assert.equal(liveWindows().length, 1, "Cancel must wait for in-flight request delivery");
  releaseDelayedRequest();
  await expectTarget(targets[2]);
  await cancelDialog();
  await until(() => liveWindows().length === 0, "fresh tray confirmation canceled");
  assert.equal(executions, 0);
  process.stdout.write("checking-simulated-success-feedback\n");
  await launchSecond(targets[3]);
  await expectTarget(targets[3]);
  await clickConfirmationRow(true);
  await evaluate('document.querySelector(".force-delete-dialog button.danger").click()');
  await until(() => executionBusy, "confirmed simulated operation started");
  const deletingWindow = currentWindow();
  deletingWindow.close();
  assert.equal(deletingWindow.isDestroyed(), false, "Native close must wait for the active deletion result");
  await until(async () => await evaluate('document.querySelector("#force-delete-completion-title")?.textContent === "已永久删除"'), "visible completion result");
  assert.equal(executions, 1);
  assert.equal(await evaluate('document.querySelectorAll(".force-delete-dialog").length'), 0);
  assert.match(await evaluate('document.querySelector(".force-delete-completion-body").textContent'), /目标已永久删除/);
  assert.equal(await evaluate('document.querySelector(".force-delete-completion footer button").textContent'), "完成");
  await capture("standalone-force-delete-success.png");
  void evaluate('document.querySelector(".force-delete-completion footer button").click()').catch(() => {});
  await until(() => liveWindows().length === 0, "Done closes the completion window");
  assert.deepEqual(previews, [targets[0], targets[1], targets[2], targets[0], targets[1], targets[2], targets[3]]);
  assert.equal(launches.length, 6, "Six real secondary processes must reach the primary instance");
  assert.deepEqual(launches.map(item => item.additionalData?.forceDeleteArgv), [targets[1], targets[2], targets[0], targets[1], targets[2], targets[3]].map(target => ["--force-delete-path", target]));
  process.stdout.write("explorer-launch-ok\n");
  app.quit();
})().catch(error => { process.stderr.write(String(error.stack) + "\n"); app.exit(1); });
`);
let child, timeout;
try {
  const environment = { ...process.env, CDRIVESHIFTAI_DATA_DIR: data, CSHIFT_SMOKE_WORKSPACE: workspace,
    CSHIFT_SMOKE_TARGETS: JSON.stringify([first, second, third, fourth]) };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(workspace, "node_modules/electron/dist/electron.exe"),
    [fixture, "--force-delete-path", first],
    { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([once(child, "exit"), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Explorer launch smoke timed out: " + output + errors)), 75_000);
  })]);
  assert.equal(code, 0, errors);
  assert.match(output, /explorer-launch-ok/);
  for (const file of [first, path.join(second, "keep.txt"), third, fourth]) assert.equal(await readFile(file, "utf8"), "untouched");
  console.log(JSON.stringify({ ok: true, coldLaunch: true, warmQueue: true, trayRecreation: true,
    standaloneWindowOnly: true, existingMainUntouched: true, noMainWindowFlash: true,
    actualSecondProcesses: true, exactUnicodePath: true, confirmationRequired: true, consentMouseClickFeedback: true,
    confirmationResetsPerTarget: true, nativeCloseCancels: true, activeDeletionCloseGuard: true, inFlightRequestPreservedOnCancel: true,
    simulatedSuccessFeedback: true, noRealDeletion: true, noRegistryChanges: true }, null, 2));
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) {
    child.kill(); await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  const relative = path.relative(tempRoot, path.resolve(fixture));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
