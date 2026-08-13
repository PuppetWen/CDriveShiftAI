import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(import.meta.dirname, "..");
const url =
  process.argv[2] ??
  `${pathToFileURL(path.join(workspace, "dist", "index.html")).toString()}?view=settings`;
const screenshotPath = process.argv[3];
const shortcutScreenshotPath = process.argv[4];
async function availablePort() {
  const server = (await import("node:net")).createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const port = await availablePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "cdrive-sliders-"));
const chrome = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--allow-file-access-from-files",
    "--disable-background-networking",
    "--window-size=1720,1080",
    "about:blank"
  ],
  { stdio: "ignore", windowsHide: true }
);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await wait(100);
  }
  throw new Error("Chrome debugging target did not start");
}

let socket;
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(expression, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

try {
  const page = await pageTarget();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await waitFor('document.querySelectorAll(".settings-module-nav button").length >= 3');
  await evaluate('document.querySelectorAll(".settings-module-nav button")[1].click()');
  await waitFor('document.querySelector(".ui-scale-slider input") !== null');
  const scale = await evaluate(`(() => {
    const input = document.querySelector(".ui-scale-slider input");
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const card = document.querySelector(".ui-scale-settings-card");
    const scroll = document.querySelector(".view-scroll");
    const marker = document.querySelector(".ui-scale-standard-mark");
    const slider = document.querySelector(".ui-scale-slider");
    const inputRect = input.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const thumbSize = Number.parseFloat(getComputedStyle(slider).getPropertyValue("--ui-scale-thumb-size"));
    const progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
    const expectedThumbCenter = inputRect.left + thumbSize / 2 + progress * (inputRect.width - thumbSize);
    const markerCenter = markerRect.left + markerRect.width / 2;
    const sample = document.querySelector(".ui-scale-preview strong");
    const baseFontSize = Number.parseFloat(getComputedStyle(sample).fontSize);
    const baseCardWidth = card.getBoundingClientRect().width;
    document.documentElement.style.setProperty("--text-scale", "2");
    const scaledFontSize = Number.parseFloat(getComputedStyle(sample).fontSize);
    const scaledCardWidth = card.getBoundingClientRect().width;
    document.documentElement.style.setProperty("--text-scale", "1");
    return {
      min: input.min,
      max: input.max,
      step: input.step,
      width: input.getBoundingClientRect().width,
      markerOffset: Math.abs(markerCenter - expectedThumbCenter),
      fontScaleRatio: scaledFontSize / baseFontSize,
      cardWidthDelta: Math.abs(scaledCardWidth - baseCardWidth),
      cardOverflow: card.scrollWidth > card.clientWidth + 1,
      pageCanScroll: scroll.scrollHeight > scroll.clientHeight
    };
  })()`);
  if (screenshotPath) {
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true
    });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  }
  await evaluate('document.querySelectorAll(".settings-module-nav button")[2].click()');
  await waitFor('document.querySelector(".mouse-hold-slider input") !== null');
  const mouse = await evaluate(`(() => {
    const input = document.querySelector(".mouse-hold-slider input");
    const card = document.querySelector(".mouse-shortcut-card");
    return {
      min: input.min,
      max: input.max,
      step: input.step,
      width: input.getBoundingClientRect().width,
      cardOverflow: card.scrollWidth > card.clientWidth + 1
    };
  })()`);
  const magnifier = await evaluate(`(() => {
    const sliders = [...document.querySelectorAll(".magnifier-size-setting input[type=range]")];
    const recorder = document.querySelector(".magnifier-recorder");
    return {
      count: sliders.length,
      width: sliders[0] ? { min: sliders[0].min, max: sliders[0].max, step: sliders[0].step } : null,
      height: sliders[1] ? { min: sliders[1].min, max: sliders[1].max, step: sliders[1].step } : null,
      recorder: Boolean(recorder)
    };
  })()`);
  if (shortcutScreenshotPath) {
    await evaluate('document.querySelector(".magnifier-shortcut-card").scrollIntoView({ block: "center" })');
    await wait(180);
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true
    });
    await writeFile(shortcutScreenshotPath, Buffer.from(screenshot.data, "base64"));
  }
  if (
    scale.min !== "0.5" || scale.max !== "3" || scale.step !== "0.1" ||
    scale.width < 200 || scale.markerOffset > 1 || scale.cardOverflow || !scale.pageCanScroll ||
    Math.abs(scale.fontScaleRatio - 2) > 0.02 || scale.cardWidthDelta > 1 ||
    mouse.min !== "0" || mouse.max !== "3000" || mouse.step !== "100" ||
    mouse.width < 200 || mouse.cardOverflow || magnifier.count !== 2 || !magnifier.recorder ||
    magnifier.width?.min !== "160" || magnifier.width?.max !== "1200" || magnifier.width?.step !== "20" ||
    magnifier.height?.min !== "120" || magnifier.height?.max !== "900" || magnifier.height?.step !== "20"
  ) {
    throw new Error(`Slider layout validation failed: ${JSON.stringify({ scale, mouse, magnifier })}`);
  }
  console.log(JSON.stringify({ result: "ok", scale, mouse, magnifier }, null, 2));
} finally {
  socket?.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  if (chrome.exitCode === null) await Promise.race([exited, wait(2_000)]);
  await wait(350);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
