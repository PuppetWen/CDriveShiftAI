import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// This smoke test imports the real component and styles but replaces every API
// before importing api.ts. No real files, processes or system settings are changed.
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
const outputDirectory = path.join(workspace, "review-artifacts", "delete-guidance");
const chromePath = [
  process.env.DELETE_GUIDANCE_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => candidate && existsSync(candidate));
assert(chromePath, "A local Chrome or Edge installation is required; no browser is downloaded");
await mkdir(tempRoot, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
const fixtureDirectory = await mkdtemp(path.join(tempRoot, "force-delete-guidance-"));
const profileDirectory = path.join(fixtureDirectory, "browser-profile");
const htmlPath = path.join(fixtureDirectory, "index.html");
const fixturePath = path.join(fixtureDirectory, "fixture.jsx");
const fixtureUrlPath = path.relative(workspace, fixtureDirectory).split(path.sep).join("/");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let server;
let chrome;
let chromeLaunchError;
let socket;
let nextId = 0;
const pending = new Map();
const pageErrors = [];
const checks = [];
const screenshots = [];

await writeFile(htmlPath, `<!doctype html><html lang="zh-CN" data-effect="matrix"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Force deletion guidance smoke</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>`);
await writeFile(fixturePath, `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/styles.css";
import { setAppLanguage } from "/src/lib/i18n.ts";
const state = window.__deleteSmoke = { calls: [], notifications: [], scenario: "eperm", sequence: 0, helperFailure: false };
const ordinaryPath = "E:\\\\SampleApp\\\\Cache\\\\" + "very-long-owned-application-cache-name-".repeat(4) + "locked.dat";
const protectedPath = "C:\\\\Windows\\\\System32";
window.cDriveShiftAI = {
  async previewForceDelete(targetPath) {
    state.calls.push({ operation: "preview", path: targetPath });
    if (state.scenario === "protected") throw new Error("受保护路径不能强制删除：" + targetPath);
    return {
      verificationId: "smoke-" + ++state.sequence, path: targetPath, name: "SampleApp cache", isDirectory: true,
      isSymbolicLink: false, highRisk: state.scenario === "eperm", elevated: state.scenario === "eperm",
      processes: [{ pid: 4242, name: "SampleApp.exe", executablePath: "E:\\\\SampleApp\\\\SampleApp.exe", canTerminate: true },
        { pid: 5151, name: "SampleProtectedService.exe", executablePath: "E:\\\\SampleApp\\\\service.exe", canTerminate: false }]
    };
  },
  async executeForceDelete(verificationId) {
    state.calls.push({ operation: "execute", verificationId });
    if (state.scenario.startsWith("elevation")) {
      await new Promise(resolve => { state.finishElevation = resolve; });
      if (state.scenario === "elevation-success") return { deleted: true, terminatedProcesses: [], usedElevation: true };
      throw new Error(state.scenario === "elevation-cancelled" ? "DELETE_ELEVATION_CANCELLED: 管理员授权已取消" : "DELETE_ELEVATION_FAILED: PowerShell: Access denied");
    }
    throw new Error((state.scenario === "eperm" ? "EPERM: operation not permitted, unlink '" : "EBUSY: resource busy or locked, unlink '") + ordinaryPath + "'");
  },
  async getForceDeleteContextMenuStatus() {
    state.calls.push({ operation: "context-menu-status" });
    if (state.menuStatusError) throw new Error("SMOKE registry status unavailable");
    return { ...state.menuStatus };
  },
  async updateSettings(patch) {
    state.calls.push({ operation: "settings-update", patch });
    await new Promise(resolve => { state.finishMenuUpdate = resolve; });
    if (state.menuUpdateError) throw new Error("SMOKE registry write denied");
    state.settings = { ...state.settings, ...patch };
    if (!state.menuIgnoreWrite) state.menuStatus = { ...state.menuStatus, enabled: patch.forceDeleteContextMenu, reason: undefined };
    return { ...state.settings };
  },
  async getMouseShortcutStatus() { return { available: false, active: false, button: "disabled", holdMs: 3000, message: "Disabled in smoke" }; },
  async getMagnifierStatus() { return { available: false, enabled: false, active: false, message: "Disabled in smoke" }; },
  async openDeleteHelper(target) {
    if (!["task-manager", "installed-apps"].includes(target)) throw new Error("Unexpected helper target: " + target);
    state.calls.push({ operation: "helper", target });
    if (state.helperFailure) throw new Error("SMOKE helper unavailable; press Ctrl + Shift + Esc");
  },
  async revealPath(targetPath) { state.calls.push({ operation: "reveal", path: targetPath }); },
  async copyText(text) { state.calls.push({ operation: "copy", text }); },
  async openExternal(url) { state.calls.push({ operation: "external", url }); },
  async navigateApp(event) { state.calls.push({ operation: "navigate", event }); }
};
const { ForceDeleteDialog } = await import("/src/components/ForceDeleteDialog.tsx");
const { SettingsView } = await import("/src/views/SettingsView.tsx");
const { SAFE_MODE_HELP_URL } = await import("/src/lib/force-delete-guidance.ts");
state.safeModeHelpUrl = SAFE_MODE_HELP_URL;
const root = createRoot(document.getElementById("root"));
let renderId = 0;
window.__runDeleteScenario = (scenario, language) => {
  state.scenario = scenario; state.calls = []; state.notifications = []; state.sequence = 0; state.helperFailure = false;
  state.finishElevation = undefined;
  setAppLanguage(language);
  state.path = scenario === "protected" ? protectedPath : ordinaryPath;
  root.render(React.createElement(ForceDeleteDialog, {
    key: ++renderId, path: state.path,
    onClose: () => state.calls.push({ operation: "close" }),
    onDeleted: (targetPath) => {
      if (state.scenario !== "elevation-success") throw new Error("Unexpected mock deletion: " + targetPath);
      state.calls.push({ operation: "deleted", path: targetPath });
    },
    notify: (type, message) => state.notifications.push({ type, message })
  }));
};
function SettingsFixture() {
  const [settings, setSettings] = React.useState(state.settings);
  return React.createElement("main", { className: "view-scroll", style: { height: "100vh", padding: "24px" } }, React.createElement(SettingsView, {
    settings, indexer: { mode: "cached", state: "ready", entries: 0 }, activeModule: "system",
    onSettings: setSettings, onModuleChange: () => {}, onCheckForUpdates: async () => ({}),
    notify: (type, message) => state.notifications.push({ type, message })
  }));
}
window.__runMenuScenario = (scenario, language) => {
  state.scenario = scenario; state.calls = []; state.notifications = [];
  state.menuStatus = { enabled: scenario === "stale" || scenario === "removal-unavailable", available: scenario !== "unavailable" && scenario !== "removal-unavailable",
    reason: scenario === "stale" ? "应用路径已变化，请重新注册" : scenario.includes("unavailable") ? "此运行方式无法启用菜单" : undefined };
  state.menuStatusError = scenario === "status-error"; state.menuUpdateError = false; state.menuIgnoreWrite = false;
  state.settings = { effectMode: "aurora", language, uiScale: 1, launchAtLogin: false, launchMinimized: false, minimizeToTray: true,
    forceDeleteContextMenu: true, globalShortcut: "", quickSearchShortcut: "", mouseQuickSearchButton: "disabled", mouseQuickSearchHoldMs: 3000,
    magnifierEnabled: false, magnifierModifiers: "Ctrl", magnifierWidth: 480, magnifierHeight: 300, indexRoots: ["*"], excludedPaths: [],
    ai: { enabled: false, provider: "openai", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "", hasApiKey: false, privacyMode: "metadata-only" }
  };
  setAppLanguage(language);
  root.render(React.createElement(SettingsFixture, { key: ++renderId }));
};
window.__fixtureReady = true;
`);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function waitFor(expression, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${expression}; errors=${JSON.stringify(pageErrors)}`);
}

async function check(name, expression) {
  assert.equal(await evaluate(expression), true, name);
  checks.push(name);
}

async function click(selector, label) {
  const rect = await evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(item => ${label === undefined ? "true" : `item.textContent?.trim() === ${JSON.stringify(label)}`});
    if (!element || element.disabled) return null;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  })()`);
  assert(rect, `An enabled element must exist: ${selector} ${label ?? ""}`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button: "left", clickCount: 1 });
}

async function resize(width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await wait(100);
}

async function capture(name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const screenshotPath = path.join(outputDirectory, `${name}.png`);
  await writeFile(screenshotPath, Buffer.from(result.data, "base64"));
  screenshots.push(screenshotPath);
}

async function checkLayout(name) {
  const layout = await evaluate(`(() => {
    const dialog = document.querySelector(".force-delete-dialog");
    const body = document.querySelector(".force-delete-body");
    const header = dialog.querySelector("header");
    const headerBounds = header.getBoundingClientRect();
    const titleBounds = header.querySelector("h2").getBoundingClientRect();
    const footer = dialog.querySelector("footer");
    const bounds = dialog.getBoundingClientRect();
    const overflowingButtons = [...dialog.querySelectorAll("button")].filter(button => {
      if (!button.checkVisibility()) return false;
      const rect = button.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
    }).map(button => button.textContent);
    return {
      left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
      width: innerWidth, height: innerHeight, contentOverflow: body.scrollWidth - body.clientWidth,
      headerBottom: headerBounds.bottom, titleBottom: titleBounds.bottom,
      footerBottom: footer.getBoundingClientRect().bottom, overflowingButtons
    };
  })()`);
  assert(layout.left >= -1 && layout.right <= layout.width + 1 && layout.top >= -1 && layout.bottom <= layout.height + 1,
    `${name}: dialog must fit viewport ${JSON.stringify(layout)}`);
  assert(layout.contentOverflow <= 1, `${name}: guidance must not overflow horizontally ${JSON.stringify(layout)}`);
  assert(layout.titleBottom <= layout.headerBottom + 1, `${name}: wrapped title must remain inside header ${JSON.stringify(layout)}`);
  assert.equal(layout.overflowingButtons.length, 0, `${name}: helper/footer buttons must fit dialog ${JSON.stringify(layout)}`);
  assert(layout.footerBottom <= layout.height + 1, `${name}: confirmation controls must remain visible`);
  checks.push(`${name}: dialog, long paths and controls fit viewport`);
}

async function runScenario(scenario, language, width = 1200, height = 1000) {
  await resize(width, height);
  await evaluate(`window.__runDeleteScenario(${JSON.stringify(scenario)}, ${JSON.stringify(language)})`);
  await waitFor(scenario === "protected"
    ? 'document.querySelector(".force-delete-guidance")?.dataset.reason === "protected"'
    : 'document.querySelector(".force-delete-confirmation input") !== null');
  await wait(220);
}

async function causeFailure(category) {
  await check("confirmation is required before deletion", 'document.querySelector("footer button.danger")?.disabled === true');
  await click(".force-delete-confirmation input");
  await waitFor('document.querySelector("footer button.danger")?.disabled === false');
  await click("footer button.danger");
  await waitFor(`document.querySelector(".force-delete-guidance")?.dataset.reason === ${JSON.stringify(category)}`);
  await check("failure consumes confirmation and disables delete", '!document.querySelector(".force-delete-confirmation input") && document.querySelector("footer button.danger")?.disabled === true');
}

try {
  server = await createServer({ root: workspace, server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  const vitePort = server.httpServer.address().port;
  chrome = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${profileDirectory}`, "--no-first-run", "--disable-background-networking",
    "--disable-default-apps", "--hide-scrollbars", "--window-size=1200,1000", "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  chrome.on("error", (error) => { chromeLaunchError = error; });
  let debugPort;
  for (let attempt = 0; attempt < 100 && !debugPort; attempt++) {
    if (chromeLaunchError) throw chromeLaunchError;
    try { debugPort = Number((await readFile(path.join(profileDirectory, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { await wait(100); }
  }
  assert(debugPort, "Chrome must expose its isolated debugging port");
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  assert(page, "Chrome must expose a page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/${fixtureUrlPath}/index.html` });
  await waitFor("window.__fixtureReady === true", 200);

  await runScenario("eperm", "zh-CN");
  await causeFailure("permission");
  await check("administrator failure does not ask for elevation again", `(() => {
    const text = document.querySelector(".force-delete-guidance > ol").innerText;
    return text.includes("当前已是管理员") && !text.includes("以管理员身份运行");
  })()`);
  await check("last checked app and protected PID are preserved", `(() => {
    const text = document.querySelector(".force-delete-last-processes")?.innerText || "";
    return text.includes("SampleApp.exe · PID 4242") && text.includes("PID 5151") && text.includes("受保护，不结束");
  })()`);
  await checkLayout("Chinese administrator EPERM");
  await capture("zh-admin-eperm-guidance");
  await click(".force-delete-error-details summary");
  await check("error disclosure preserves errno and full original path", 'document.querySelector(".force-delete-error-details").open && document.querySelector(".force-delete-error-details .force-delete-error").innerText.includes("EPERM") && document.querySelector(".force-delete-error-details .force-delete-error").innerText.includes(window.__deleteSmoke.path)');
  await capture("zh-admin-eperm-details");
  await click(".force-delete-help-actions button", "定位文件");
  await click(".force-delete-help-actions button", "复制路径");
  await click(".force-delete-help-actions button", "打开任务管理器");
  await click(".force-delete-help-actions button", "打开已安装的应用");
  await check("helper actions use fixed names and preserve target path", `(() => {
    const {calls,path} = window.__deleteSmoke;
    return JSON.stringify(calls.filter(call => call.operation === "helper").map(call => call.target)) === JSON.stringify(["task-manager", "installed-apps"])
      && calls.some(call => call.operation === "reveal" && call.path === path)
      && calls.some(call => call.operation === "copy" && call.text === path);
  })()`);
  await evaluate("window.__deleteSmoke.helperFailure = true");
  await click(".force-delete-help-actions button", "打开任务管理器");
  await waitFor('window.__deleteSmoke.notifications.some(item => item.type === "error" && item.message.includes("SMOKE helper unavailable"))');
  await check("helper launch failures preserve original deletion guidance", 'document.querySelector(".force-delete-guidance")?.dataset.reason === "permission"');
  await click("footer button", "重新检查");
  await waitFor('document.querySelector(".force-delete-confirmation input") !== null');
  await check("rechecking requires a fresh user confirmation and does not execute", `(() => {
    const calls = window.__deleteSmoke.calls;
    return !document.querySelector(".force-delete-confirmation input").checked && document.querySelector("footer button.danger").disabled
      && calls.filter(call => call.operation === "preview").length === 2 && calls.filter(call => call.operation === "execute").length === 1;
  })()`);
  await capture("zh-fresh-check-needs-confirmation");
  await causeFailure("permission");
  await check("retry uses a different single-use verification token", `(() => {
    const calls = window.__deleteSmoke.calls.filter(call => call.operation === "execute");
    return calls.length === 2 && calls[0].verificationId !== calls[1].verificationId;
  })()`);

  for (const language of ["zh-CN", "en-US"]) {
    await runScenario("protected", language, 560, 850);
    await check(`${language}: protected paths offer uninstall without bypass or retry controls`, `(() => {
      const text = document.querySelector(".force-delete-guidance > ol").innerText;
      const buttons = [...document.querySelectorAll("footer button")].map(button => button.textContent.trim());
      return !document.querySelector(".force-delete-advanced-help") && !document.querySelector(".force-delete-confirmation")
        && !buttons.includes("重新检查") && !buttons.includes("Check again") && !text.includes("以管理员身份运行") && !text.includes("Run as administrator")
        && ![...document.querySelectorAll(".force-delete-help-actions button")].some(button => /任务管理器|Task Manager/.test(button.textContent));
    })()`);
    await click(".force-delete-help-actions button", language === "zh-CN" ? "打开已安装的应用" : "Open installed apps");
    await check(`${language}: protected path uninstall helper has fixed target`, 'window.__deleteSmoke.calls.some(call => call.operation === "helper" && call.target === "installed-apps")');
    await checkLayout(`${language} protected narrow`);
    await capture(`${language === "zh-CN" ? "zh" : "en"}-protected-narrow`);
  }

  for (const language of ["zh-CN", "en-US"]) {
    await runScenario("busy", language, 560, 850);
    await causeFailure("busy");
    await check(`${language}: ordinary lock offers practical close-app steps`, `(() => {
      const text = document.querySelector(".force-delete-guidance > ol").innerText;
      return /托盘|tray icon/.test(text) && /资源管理器|Explorer/.test(text) && /PID/.test(text) && !/以管理员身份运行|Run as administrator/.test(text);
    })()`);
    await check(`${language}: advanced restart help starts collapsed`, 'document.querySelector(".force-delete-advanced-help")?.open === false');
    await checkLayout(`${language} EBUSY narrow`);
    await capture(`${language === "zh-CN" ? "zh" : "en"}-busy-narrow`);
    await click(".force-delete-advanced-help summary");
    await check(`${language}: advanced guidance describes restart, safe mode and its limits`, `(() => {
      const details = document.querySelector(".force-delete-advanced-help");
      return details.open && details.innerText.includes("Shift") && details.innerText.includes("4/F4") && details.innerText.includes("BitLocker")
        && /不会授予缺失的文件权限|does not grant missing file permissions/.test(details.innerText);
    })()`);
    await click(".force-delete-advanced-help button", language === "zh-CN" ? "微软安全模式说明" : "Microsoft Safe Mode guide");
    await check(`${language}: guide link uses official fixed documentation URL`, 'window.__deleteSmoke.calls.some(call => call.operation === "external" && call.url === window.__deleteSmoke.safeModeHelpUrl && call.url.startsWith("https://support.microsoft.com/"))');
    await checkLayout(`${language} expanded EBUSY narrow`);
    await evaluate('document.querySelector(".force-delete-advanced-help summary").scrollIntoView({ block: "start" })');
    await capture(`${language === "zh-CN" ? "zh" : "en"}-busy-safe-mode-expanded`);
  }

  await runScenario("eperm", "en-US", 560, 850);
  await causeFailure("permission");
  await check("English administrator message does not request repeated elevation", 'document.querySelector(".force-delete-guidance > ol").innerText.includes("already running as administrator") && !document.querySelector(".force-delete-guidance > ol").innerText.includes("Run as administrator")');
  await checkLayout("English EPERM narrow");
  await capture("en-admin-eperm-narrow");
  const fontBefore = await evaluate('parseFloat(getComputedStyle(document.querySelector(".force-delete-guidance li")).fontSize)');
  await evaluate('document.documentElement.style.setProperty("--text-scale", "2")');
  await wait(150);
  const fontAfter = await evaluate('parseFloat(getComputedStyle(document.querySelector(".force-delete-guidance li")).fontSize)');
  assert.equal(fontAfter, fontBefore * 2, "Actual Vite textScaleCssPlugin must scale guidance text");
  checks.push("actual Vite text scale CSS plugin doubles guidance font sizes");
  await checkLayout("English EPERM narrow at text scale 2");
  await capture("en-admin-eperm-narrow-text-scale-2");
  await click(".force-delete-advanced-help summary");
  await checkLayout("Expanded English help narrow at text scale 2");
  await evaluate('document.querySelector(".force-delete-advanced-help summary").scrollIntoView({ block: "start" })');
  await capture("en-safe-mode-narrow-text-scale-2");
  await evaluate('document.documentElement.style.setProperty("--text-scale", "1")');
  for (const scenario of ["elevation-cancelled", "elevation-failed", "elevation-success"]) {
    await runScenario(scenario, "zh-CN", 700, 850);
    await check(`${scenario}: confirmation explains administrator PowerShell and target permissions`, 'document.querySelector(".force-delete-confirmation").innerText.includes("管理员 PowerShell") && document.querySelector(".force-delete-warning").innerText.includes("所选目标及其内容")');
    await click(".force-delete-confirmation input");
    await click("footer button.danger");
    await waitFor('typeof window.__deleteSmoke.finishElevation === "function"');
    await check(`${scenario}: pending authorization blocks duplicate deletion and explains UAC`, 'document.querySelector("footer button.danger").disabled && document.querySelector("footer").innerText.includes("UAC") && !document.querySelector(".force-delete-guidance")');
    await checkLayout(`${scenario} while waiting for UAC`);
    await evaluate("window.__deleteSmoke.finishElevation()");
    if (scenario === "elevation-success") {
      await waitFor('window.__deleteSmoke.notifications.some(item => item.type === "success")');
      await check("successful elevated result reports administrator access", 'window.__deleteSmoke.notifications.some(item => item.message.includes("已通过管理员权限")) && window.__deleteSmoke.calls.some(item => item.operation === "deleted")');
    } else {
      const category = scenario === "elevation-cancelled" ? "authorization" : "elevation";
      await waitFor(`document.querySelector(".force-delete-guidance")?.dataset.reason === ${JSON.stringify(category)}`);
      await check(`${scenario}: consumes old confirmation without falsely reporting deletion`, '!document.querySelector(".force-delete-confirmation") && document.querySelector("footer button.danger").disabled && !window.__deleteSmoke.notifications.some(item => item.type === "success")');
      await capture(scenario);
      await click("footer button", "重新检查");
      await waitFor('document.querySelector(".force-delete-confirmation input") !== null');
      await check(`${scenario}: retry requires fresh unchecked preview`, '!document.querySelector(".force-delete-confirmation input").checked && window.__deleteSmoke.calls.filter(item => item.operation === "preview").length === 2');
    }
  }

  const menuInput = '.force-delete-context-menu-card input[type="checkbox"]';
  async function menuScenario(scenario, language = "zh-CN") {
    await resize(1280, 1000);
    await evaluate(`window.__runMenuScenario(${JSON.stringify(scenario)}, ${JSON.stringify(language)})`);
    await waitFor('window.__deleteSmoke.calls.some(item => item.operation === "context-menu-status") && document.querySelector(".context-menu-status") !== null && !/正在检查|Checking registration/.test(document.querySelector(".context-menu-status").innerText)');
    await wait(320);
  }
  async function toggleMenu() {
    await evaluate('window.__deleteSmoke.finishMenuUpdate = undefined');
    await click(".force-delete-context-menu-card .setting-row");
    await waitFor('typeof window.__deleteSmoke.finishMenuUpdate === "function"');
  }
  async function finishMenu() {
    await evaluate('window.__deleteSmoke.finishMenuUpdate()');
    await waitFor('!/正在更新|Updating the context menu/.test(document.querySelector(".context-menu-status").innerText)');
  }
  await menuScenario("ordinary");
  await check("Explorer menu uses real registry status instead of stale saved settings", `!document.querySelector(${JSON.stringify(menuInput)}).checked && window.__deleteSmoke.settings.forceDeleteContextMenu === true`);
  await check("Explorer menu explains preview confirmation and Windows 11 location", 'document.querySelector(".force-delete-context-menu-card").innerText.includes("核对并确认后才会执行") && document.querySelector(".force-delete-context-menu-card").innerText.includes("显示更多选项")');
  await toggleMenu();
  await check("pending menu registration cannot falsely show enabled", `document.querySelector(${JSON.stringify(menuInput)}).disabled && !document.querySelector(${JSON.stringify(menuInput)}).checked && !window.__deleteSmoke.notifications.some(item => item.type === "success")`);
  await finishMenu();
  await check("registered menu is checked only after update and verification", `document.querySelector(${JSON.stringify(menuInput)}).checked && !document.querySelector(${JSON.stringify(menuInput)}).disabled && window.__deleteSmoke.notifications.some(item => item.type === "success")`);
  await toggleMenu();
  await finishMenu();
  await check("disabling menu persists false and verifies removal", `!document.querySelector(${JSON.stringify(menuInput)}).checked && window.__deleteSmoke.calls.some(item => item.operation === "settings-update" && item.patch.forceDeleteContextMenu === false)`);
  await evaluate('window.__deleteSmoke.menuUpdateError = true; window.__deleteSmoke.notifications = []');
  await toggleMenu();
  await finishMenu();
  await check("failed registration rolls back checked state and reports failure", `!document.querySelector(${JSON.stringify(menuInput)}).checked && document.querySelector(".context-menu-warning").innerText.includes("SMOKE registry write denied") && !window.__deleteSmoke.notifications.some(item => item.type === "success")`);
  await capture("context-menu-write-failed");
  await evaluate('window.__deleteSmoke.menuUpdateError = false; window.__deleteSmoke.menuIgnoreWrite = true; window.__deleteSmoke.notifications = []');
  await toggleMenu();
  await finishMenu();
  await check("successful settings save without registry write is not reported as success", `!document.querySelector(${JSON.stringify(menuInput)}).checked && window.__deleteSmoke.notifications.some(item => item.type === "error") && !window.__deleteSmoke.notifications.some(item => item.type === "success")`);
  await menuScenario("stale");
  await check("stale menu registration offers clear repair guidance", `document.querySelector(${JSON.stringify(menuInput)}).checked && document.querySelector(".force-delete-context-menu-card").innerText.includes("先关闭再重新开启")`);
  await capture("context-menu-stale-path");
  await toggleMenu();
  await finishMenu();
  await toggleMenu();
  await finishMenu();
  await check("turning stale menu off and on repairs current registration", `document.querySelector(${JSON.stringify(menuInput)}).checked && !document.querySelector(".context-menu-warning")`);
  await menuScenario("removal-unavailable");
  await check("unavailable launch still permits removing an existing menu", `document.querySelector(${JSON.stringify(menuInput)}).checked && !document.querySelector(${JSON.stringify(menuInput)}).disabled`);
  await toggleMenu();
  await finishMenu();
  await check("after removal unavailable launch prevents enabling", `!document.querySelector(${JSON.stringify(menuInput)}).checked && document.querySelector(${JSON.stringify(menuInput)}).disabled`);
  await menuScenario("status-error");
  await check("unknown registry status disables toggle and shows readable error", `document.querySelector(${JSON.stringify(menuInput)}).disabled && document.querySelector(".context-menu-warning").innerText.includes("SMOKE registry status unavailable")`);
  await evaluate('window.__deleteSmoke.menuStatusError = false');
  await click(".context-menu-status button", "重新检查状态");
  await waitFor(`!document.querySelector(${JSON.stringify(menuInput)}).disabled`);
  await check("status check can recover without updating system settings", 'window.__deleteSmoke.calls.filter(item => item.operation === "settings-update").length === 0 && !document.querySelector(".context-menu-warning")');
  await menuScenario("ordinary", "en-US");
  await evaluate('document.querySelector(".force-delete-context-menu-card").scrollIntoView({ block: "center" })');
  await check("English menu help includes confirmation and classic menu location", 'document.querySelector(".force-delete-context-menu-card").innerText.includes("review and confirm") && document.querySelector(".force-delete-context-menu-card").innerText.includes("Show more options")');
  await capture("context-menu-english");
  assert.deepEqual(pageErrors, [], "Component must not produce uncaught browser exceptions");
  checks.push("no uncaught browser exceptions");
  const result = { ok: true, checks, screenshots, mockedSystemActions: true };
  await writeFile(path.join(outputDirectory, "smoke-results.json"), JSON.stringify(result, null, 2));
  await rm(path.join(outputDirectory, "failure.png"), { force: true });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await capture("failure"); } catch { /* Preserve the original test failure. */ }
  }
  await writeFile(path.join(outputDirectory, "smoke-results.json"), JSON.stringify({
    ok: false, error: error instanceof Error ? error.message : String(error), checks, screenshots, mockedSystemActions: true
  }, null, 2));
  throw error;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, wait(3000)]);
  }
  await server?.close();
  const resolvedFixture = path.resolve(fixtureDirectory);
  const relativeFixture = path.relative(path.resolve(tempRoot), resolvedFixture);
  assert(relativeFixture && !relativeFixture.startsWith("..") && !path.isAbsolute(relativeFixture), "Only remove this smoke fixture under .test-tmp");
  await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
