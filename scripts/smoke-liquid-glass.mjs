// Uses installed Chrome and Node's CDP/WebSocket support; no test dependencies.
// Run after npm run build:web:
//   node scripts/smoke-liquid-glass.mjs [preview-url] [output-directory] [--baseline]
// All normal pages use the application's browser preview API. Utility windows
// receive read-only fixtures; no Electron IPC or real filesystem operation runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((value) => value !== "--baseline");
const baseline = process.argv.includes("--baseline");
const previewUrl = args[0] || pathToFileURL(path.join(workspace, "dist/index.html")).href;
const output = path.resolve(args[1] || path.join(workspace, "artifacts/liquid-glass"));
const chromePath = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((candidate) => candidate && existsSync(candidate));
assert(chromePath, "Install a browser or set CHROME_PATH to an existing local browser");
const themes = [["aurora", "方块"], ["matrix", "科技"], ["calm", "晶境"], ["ember", "熔橙"], ["ivory", "暖瓷"]];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temporaryRoot = path.join(workspace, ".cdriveshiftai-data/test-temp");
await mkdir(temporaryRoot, { recursive: true });
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(temporaryRoot, "liquid-glass-"));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`,
  "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run",
  "--allow-file-access-from-files", "--disable-background-networking", "--disable-default-apps",
  "--window-size=1600,1000", "about:blank"], { stdio: "ignore", windowsHide: true });
let socket;
let sequence = 0;
const pending = new Map();
const report = { previewUrl, baseline, scenes: [], contrast: [], reflections: [], accessibility: [], runtimeErrors: [] };

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function click(selector, label, right = false) {
  const position = await evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) =>
      ${label ? `(item.textContent.trim() === ${JSON.stringify(label)} || item.querySelector("span")?.textContent.trim() === ${JSON.stringify(label)})` : "true"});
    if (!element) return null;
    element.scrollIntoView({ block: "nearest" });
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, enabled: !element.disabled, hit: element.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert(position?.enabled && position.hit, `Control blocked or missing: ${selector} ${label || ""}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: position.x, y: position.y, button: right ? "right" : "left", clickCount: 1 });
  }
}
async function fill(selector, value) {
  await click(selector);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await send("Input.insertText", { text: value });
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
}
async function escape() {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
async function navigate(params, theme) {
  const url = new URL(previewUrl);
  url.search = new URLSearchParams({ ...params, effect: theme[0] }).toString();
  await send("Page.navigate", { url: url.href });
  await waitFor('document.querySelector(".effect-switcher button, .quick-search-effect-switcher button") !== null');
  await click(".effect-switcher button, .quick-search-effect-switcher button", theme[1]);
  await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(theme[0])}`);
  await delay(450);
}
async function capture(name, selectors) {
  await delay(130);
  const surfaces = await evaluate(`(() => {
    return ${JSON.stringify(selectors)}.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const s = getComputedStyle(element), r = element.getBoundingClientRect();
      return { selector, text: element.textContent.trim().slice(0, 85), color: s.color,
        background: s.backgroundColor, image: s.backgroundImage, backdrop: s.backdropFilter,
        border: s.borderColor, radius: s.borderRadius, opacity: s.opacity,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        outsideViewport: r.right > innerWidth + 2 || r.bottom > innerHeight + 2 || r.left < -2 || r.top < -2 };
    });
  })()`);
  assert(surfaces.every((surface) => !surface.missing && surface.rect.width > 0 && surface.rect.height > 0), `Missing rendered surface in ${name}`);
  const viewportOverflow = await evaluate('document.documentElement.scrollWidth > innerWidth + 2');
  assert(!viewportOverflow, `Horizontal page overflow in ${name}`);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
  report.scenes.push({ name, surfaces });
  console.log(`Captured ${name}`);
}
async function openMenu() {
  await click(".result-grid-row", undefined, true);
  await waitFor('document.querySelector(".search-context-menu") !== null');
}

async function hoverPath() {
  const point = await evaluate(`(() => {
    const r = document.querySelector(".path-input").getBoundingClientRect();
    return { x: r.left + r.width * .6, y: r.top + r.height * .65 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await delay(80);
  return evaluate(`(() => {
    const targets = [...document.querySelectorAll('[data-glass-lit="true"]')];
    return { count: targets.length, path: targets[0]?.matches(".path-input") || false,
      x: targets[0]?.style.getPropertyValue("--glass-pointer-x"), y: targets[0]?.style.getPropertyValue("--glass-pointer-y") };
  })()`);
}

// Measure the actual composited pixels underneath a short label. Hiding only
// text fill preserves the glass backdrop, border, layout and shadows. Canvas
// decodes Chrome's screenshot, so modern color() / gradient syntax is handled
// by the browser rather than guessed from CSS strings.
async function labelContrast(name, selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element), r = element.getBoundingClientRect();
    const color = style.color;
    const original = element.style.getPropertyValue("-webkit-text-fill-color");
    element.style.setProperty("-webkit-text-fill-color", "transparent");
    return { color, original, x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  assert(target, `Missing contrast target: ${selector}`);
  try {
    await delay(100);
    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true,
      clip: { x: target.x, y: target.y, width: target.width, height: target.height, scale: 1 } });
    const result = await evaluate(`(async () => {
      const canvas = document.createElement("canvas");
      const image = new Image();
      image.src = "data:image/png;base64,${shot.data}";
      await image.decode();
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = ${JSON.stringify(target.color)};
      context.fillRect(0, 0, canvas.width, canvas.height);
      const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      context.drawImage(image, 0, 0);
      const luminance = (rgb) => rgb.map((channel) => channel / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index], 0);
      const text = luminance(foreground);
      const samples = [.3, .5, .7].map((x) => {
        const rgb = [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
        const bg = luminance(rgb);
        return { rgb, ratio: (Math.max(text, bg) + .05) / (Math.min(text, bg) + .05) };
      });
      return { foreground, samples, minimum: Math.min(...samples.map((sample) => sample.ratio)) };
    })()`);
    report.contrast.push({ name, selector, ...result });
    if (!baseline) assert(result.minimum >= 4.5, `${name} text contrast is ${result.minimum.toFixed(2)}:1 (expected 4.5:1)`);
  } finally {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).style.setProperty("-webkit-text-fill-color", ${JSON.stringify(target.original)})`);
  }
}

try {
  let page;
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((result) => result.json());
      page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    } catch { /* Browser is starting. */ }
    if (!page) await delay(80);
  }
  assert(page, "Browser failed to start");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") report.runtimeErrors.push(message.params.exceptionDetails);
    const callback = pending.get(message.id);
    if (!callback) return;
    clearTimeout(callback.timer);
    pending.delete(message.id);
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  for (const theme of themes) {
    await navigate({ view: "overview" }, theme);
    await waitFor('document.querySelector(".overview-page .glass-card") !== null');
    await capture(`${theme[0]}-overview`, [".sidebar", ".topbar", ".overview-page .glass-card"]);
    await navigate({ view: "migrate" }, theme);
    await waitFor('document.querySelectorAll(".path-input input").length === 2');
    await fill(".path-input input", "C:\\Users\\You\\Documents\\设计资源与应用数据");
    await fill(".migration-path-column:nth-of-type(3) input", "D:\\Data\\迁移目标");
    await capture(`${theme[0]}-paths-focused`, [".migration-paths", ".path-input", ".path-input input", ".check-button"]);
    await labelContrast(`${theme[0]}-path-input`, ".path-input input");
    await labelContrast(`${theme[0]}-primary-button`, ".check-button");
    const reflection = await hoverPath();
    report.reflections.push({ theme: theme[0], ...reflection });
    if (!baseline) assert(reflection.count === 1 && reflection.path && Number.parseFloat(reflection.x) > 0 && Number.parseFloat(reflection.y) > 0,
      `Pointer reflection failed for ${theme[0]}`);
    await click(".path-input input");
    if (!baseline) await waitFor('document.querySelectorAll("[data-glass-lit=true]").length === 0');
    await navigate({ view: "search" }, theme);
    await waitFor('document.querySelector(".search-input-wrap input") !== null');
    await fill(".search-input-wrap input", "RedScope");
    await waitFor('document.querySelector(".result-grid-row") !== null');
    await capture(`${theme[0]}-search`, [".search-input-wrap", ".search-filter-workbench", ".result-grid-row"]);
    await labelContrast(`${theme[0]}-search-input`, ".search-input-wrap input");
    await openMenu();
    await capture(`${theme[0]}-menu`, [".search-context-menu"]);
    assert(!report.scenes.at(-1).surfaces[0].outsideViewport, "Context menu escaped viewport");
    await click(".search-context-menu button", "属性");
    await waitFor('document.querySelector(".path-properties-metrics") !== null');
    await capture(`${theme[0]}-properties`, [".path-properties-dialog", ".path-properties-path", ".path-properties-metrics"]);
    await labelContrast(`${theme[0]}-properties-done`, ".path-properties-dialog footer button.primary");
    await escape();
    await waitFor('document.querySelector(".path-properties-dialog") === null');
    await openMenu();
    await click(".search-context-menu button", "强制永久删除…");
    await waitFor('document.querySelector(".force-delete-processes") !== null');
    assert(await evaluate('document.querySelector(".force-delete-dialog footer button.danger")?.disabled === true'), "Destructive action must require confirmation");
    await capture(`${theme[0]}-delete-dialog`, [".force-delete-dialog", ".force-delete-target", ".force-delete-confirmation"]);
    await escape();
    await waitFor('document.querySelector(".force-delete-dialog") === null');
    await navigate({ view: "settings" }, theme);
    await click(".settings-module-nav button:nth-child(2)");
    await waitFor('document.querySelector(".language-picker-trigger") !== null');
    await click(".language-picker-trigger");
    await waitFor('document.querySelector(".language-picker-popover") !== null');
    await capture(`${theme[0]}-language`, [".language-picker-popover", ".language-picker-search"]);
    await navigate({ mode: "quick-search" }, theme);
    await fill(".search-input-wrap input", "RedScope");
    await waitFor('document.querySelector(".result-grid-row") !== null');
    await capture(`${theme[0]}-quick-search`, [".quick-search-titlebar", ".search-input-wrap", ".result-grid-row"]);
  }

  // Utility-only preload fixtures exercise the actual renderer and CSS cascade.
  for (const [effect] of themes) {
    const preload = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      let delivered = false;
      const noop = () => () => undefined;
      window.cDriveShiftAI = {
        getSettings: async () => ({ effectMode: ${JSON.stringify(effect)}, language: "zh-CN", uiScale: 1 }),
        onSettingsChanged: noop, onTextScalePreview: noop, onForceDeleteRequests: noop,
        takeForceDeleteRequests: async () => { if (delivered) return []; delivered = true; return ["C:\\\\Apps\\\\Example Studio"]; },
        previewForceDelete: async (target) => ({ verificationId: "fixture-only", path: target, name: "Example Studio", isDirectory: true,
          isSymbolicLink: false, highRisk: true, elevated: false,
          processes: [{ pid: 1234, name: "Example Studio.exe", executablePath: target + "\\\\Example Studio.exe", matchReason: "executable", canTerminate: true }] }),
        finishUtilityWindow: async () => undefined, listMigrations: async () => []
      };
    })();` });
    const url = new URL(previewUrl);
    url.search = new URLSearchParams({ mode: "force-delete", effect }).toString();
    await send("Page.navigate", { url: url.href });
    await waitFor('document.querySelector(".force-delete-process-list") !== null');
    await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
    await capture(`${effect}-delete-utility`, [".force-delete-dialog", ".force-delete-target", ".force-delete-process-list"]);
    url.searchParams.set("mode", "uninstall-restore");
    await send("Page.navigate", { url: url.href });
    await waitFor('document.querySelector(".uninstall-empty strong") !== null');
    await capture(`${effect}-uninstall-utility`, [".uninstall-restore-window", ".uninstall-warning", ".uninstall-selection"]);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preload.identifier });
  }

  for (const feature of ["prefers-reduced-motion", "forced-colors", "prefers-contrast", "prefers-reduced-transparency"]) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: feature, value: feature === "forced-colors" ? "active" : feature === "prefers-contrast" ? "more" : "reduce" }] });
    await navigate({ view: "migrate" }, themes[1]);
    await fill(".path-input input", "C:\\Users\\You\\Documents\\清晰可读");
    const reflection = await hoverPath();
    if (!baseline) assert.equal(reflection.count, 0, `${feature} retained a pointer reflection`);
    await capture(`accessibility-${feature}`, [".sidebar", ".topbar", ".migration-paths", ".path-input"]);
    const state = await evaluate(`({
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      highContrast: matchMedia("(prefers-contrast: more)").matches,
      reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      filters: [".sidebar", ".topbar", ".migration-paths", ".path-input"].map((s) => getComputedStyle(document.querySelector(s)).backdropFilter),
      animations: document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().duration > 1).length
    })`);
    report.accessibility.push({ feature, ...state });
    if (!baseline && feature !== "prefers-reduced-motion") assert(state.filters.every((filter) => filter === "none"), `${feature} must remove glass filters`);
    if (!baseline && feature === "prefers-reduced-motion") assert.equal(state.animations, 0, "Reduced motion retained an active animation");
    await send("Emulation.setEmulatedMedia", { features: [] });
  }
  assert.equal(report.runtimeErrors.length, 0, "Renderer raised a runtime exception");
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  socket?.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  if (chrome.exitCode === null) await Promise.race([exited, delay(2000)]);
  assert(path.relative(temporaryRoot, profile).startsWith("liquid-glass-"), "Refusing to remove a profile outside the temporary workspace");
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  console.log(JSON.stringify({ ok: report.ok, scenes: report.scenes.length, output }, null, 2));
}
