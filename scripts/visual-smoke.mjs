import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const previewUrl = process.argv[2] ?? "http://127.0.0.1:5173/?view=overview";
const viewportWidth = Math.max(900, Number(process.argv[3] ?? 1600));
const viewportHeight = Math.max(600, Number(process.argv[4] ?? 1000));
const outputDirectory = path.resolve("artifacts");
const debugPort = 9237;
const testTempRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
await mkdir(testTempRoot, { recursive: true });
const profileDirectory = await mkdtemp(path.join(testTempRoot, "visual-"));

await mkdir(outputDirectory, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--disable-background-networking",
    "--disable-default-apps",
    "--hide-scrollbars",
    `--window-size=${viewportWidth},${viewportHeight}`,
    "about:blank"
  ],
  { stdio: "ignore", windowsHide: true }
);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 60) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

let socket;
let nextId = 0;
let searchSizeColumn;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return response.result?.value;
}

async function waitFor(expression, expected = true, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await evaluate(expression)) === expected) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function clickButton(label) {
  const rect = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const bounds = button.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2
    };
  })()`);
  if (!rect) throw new Error(`Button not found: ${label}`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1
  });
}

async function capture(fileName) {
  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true
  });
  await writeFile(path.join(outputDirectory, fileName), Buffer.from(screenshot.data, "base64"));
}

try {
  const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = pages.find((candidate) => candidate.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome page target was not available");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false
  });
  await send("Page.navigate", { url: previewUrl });
  await waitFor('document.readyState === "complete"');
  await waitFor(
    'document.querySelector(".effect-switcher") !== null || document.querySelector(".quick-search-workspace") !== null'
  );
  const requestedEffect = new URL(previewUrl).searchParams.get("effect");
  if (["aurora", "matrix", "calm", "ember", "ivory"].includes(requestedEffect)) {
    const labels = {
      aurora: "方块",
      matrix: "科技",
      calm: "晶境",
      ember: "熔橙",
      ivory: "暖瓷"
    };
    await clickButton(labels[requestedEffect]);
    await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(requestedEffect)}`);
  }
  const requestedView = new URL(previewUrl).searchParams.get("view") || "overview";
  await wait(350);
  await capture(`cdriveshiftai-${requestedView}.png`);

  if (requestedView === "settings") {
    const iconAlignment = await evaluate(`(() => {
      const update = document.querySelector(".brand-update-button")?.getBoundingClientRect();
      const collapse = document.querySelector(".sidebar-collapse-button")?.getBoundingClientRect();
      const bullet = document.querySelector(".update-release-items > span > i")?.getBoundingClientRect();
      const item = document.querySelector(".update-release-items > span");
      if (!update || !collapse || !bullet || !item) return null;
      const itemBounds = item.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(item).lineHeight);
      return {
        brandDelta: Math.abs(update.top + update.height / 2 - (collapse.top + collapse.height / 2)),
        releaseDelta: Math.abs(bullet.top + bullet.height / 2 - (itemBounds.top + lineHeight / 2))
      };
    })()`);
    if (!iconAlignment || iconAlignment.brandDelta > 3 || iconAlignment.releaseDelta > 3) {
      throw new Error(`Icon/text alignment regression: ${JSON.stringify(iconAlignment)}`);
    }
    const sidebarResize = await evaluate(`(() => {
      const sidebar = document.querySelector(".sidebar");
      const handle = document.querySelector(".sidebar-resize-handle");
      if (!sidebar || !handle) return null;
      const sidebarBounds = sidebar.getBoundingClientRect();
      const handleBounds = handle.getBoundingClientRect();
      return {
        x: handleBounds.left + handleBounds.width / 2,
        y: handleBounds.top + 120,
        before: sidebarBounds.width
      };
    })()`);
    if (!sidebarResize) throw new Error("Sidebar resize handle was unavailable");
    await evaluate('document.querySelector(".sidebar-resize-handle")?.focus()');
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowRight",
      code: "ArrowRight",
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowRight",
      code: "ArrowRight",
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39
    });
    await waitFor(
      `document.querySelector(".sidebar")?.getBoundingClientRect().width > ${JSON.stringify(sidebarResize.before)} + 8`
    );
    await evaluate('document.querySelector(".sidebar-resize-handle")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await waitFor('Math.abs((document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) - 238) < 2');
    const liveDrag = await evaluate(`(() => {
      const handle = document.querySelector(".sidebar-resize-handle");
      if (!handle) return null;
      const bounds = handle.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + 150 };
    })()`);
    if (!liveDrag) throw new Error("Sidebar drag target was unavailable");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: liveDrag.x,
      y: liveDrag.y,
      button: "left",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: liveDrag.x + 82,
      y: liveDrag.y,
      button: "left"
    });
    const liveWidth = await evaluate('document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0');
    if (liveWidth < 305) throw new Error(`Sidebar did not track the pointer immediately: ${liveWidth}`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: liveDrag.x + 82,
      y: liveDrag.y,
      button: "left",
      clickCount: 1
    });
    await evaluate('document.querySelector(".sidebar-resize-handle")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await waitFor('Math.abs((document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) - 238) < 2');

    const updateDot = await evaluate(`(() => {
      const button = document.querySelector(".brand-update-button");
      if (!(button instanceof HTMLButtonElement)) return null;
      const bounds = button.getBoundingClientRect();
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2
      };
    })()`);
    if (!updateDot) throw new Error("Brand update status dot was not rendered");
    if (await evaluate('document.querySelector(".settings-update-dot") !== null')) {
      throw new Error("Legacy settings update dot is still rendered");
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: updateDot.x,
      y: updateDot.y
    });
    await waitFor('document.querySelector(".themed-tooltip") !== null');
    await capture("cdriveshiftai-settings-version-tooltip.png");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
    await evaluate('document.querySelectorAll(".settings-module-nav button")[1]?.click()');
    await waitFor('document.querySelector(".language-picker-trigger") !== null');
    await evaluate('document.querySelector(".language-picker-trigger")?.click()');
    await waitFor('document.querySelector(".language-picker-popover") !== null');
    await capture("cdriveshiftai-language-picker.png");
    await evaluate(`(() => {
      const option = [...document.querySelectorAll(".language-picker-list button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "English");
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    await waitFor('[...document.querySelectorAll(".sidebar-bottom .nav-item span")].some((item) => item.textContent?.trim() === "Settings")');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".settings-module-nav button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "Updates & diagnostics");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".update-settings") !== null');
    const englishUpdateLeak = await evaluate(`(() => {
      const text = document.querySelector(".update-settings")?.textContent ?? "";
      return [...new Set(text.match(/[\\u3400-\\u9fff]+/gu) ?? [])];
    })()`);
    if (englishUpdateLeak.length > 0) {
      throw new Error(
        `Chinese text leaked into English update status or release notes: ${JSON.stringify(englishUpdateLeak)}`
      );
    }
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".settings-module-nav button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "Index & shortcuts");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".settings-system-stack") !== null');
    const englishSystemLeak = await evaluate('/[\\u3400-\\u9fff]/u.test(document.querySelector(".settings-system-stack")?.textContent ?? "")');
    if (englishSystemLeak) throw new Error("Chinese text leaked into the English system settings module");
    await clickButton("Fast search");
    await waitFor('document.querySelector(".search-filter-workbench") !== null');
    const englishSearchLayout = await evaluate(`(() => {
      const consoleText = document.querySelector(".search-console")?.textContent ?? "";
      const buttons = [...document.querySelectorAll(".match-mode-segments button")];
      const location = document.querySelector(".search-filter-location")?.getBoundingClientRect();
      const match = document.querySelector(".search-filter-match")?.getBoundingClientRect();
      const order = document.querySelector(".search-filter-order")?.getBoundingClientRect();
      return {
        chineseLeak: /[\\u3400-\\u9fff]/u.test(consoleText),
        clipped: buttons.some((button) => button.scrollWidth > button.clientWidth + 1),
        labels: buttons.map((button) => button.textContent?.trim()),
        sameRow: Boolean(location && match && order) &&
          Math.abs(location.top - match.top) < 2 &&
          Math.abs(location.top - order.top) < 2,
        visible: Boolean(location) && location.top >= 56 && location.top < window.innerHeight
      };
    })()`);
    if (
      englishSearchLayout.chineseLeak ||
      englishSearchLayout.clipped ||
      !englishSearchLayout.sameRow ||
      !englishSearchLayout.visible
    ) {
      throw new Error(`English search localization/layout regression: ${JSON.stringify(englishSearchLayout)}`);
    }
    await wait(360);
    await capture("cdriveshiftai-search-english.png");
    await clickButton("Disk ownership map");
    await waitFor('document.querySelector(".ownership-board") !== null');
    await wait(220);
    const ownershipRuntimeLeak = await evaluate(`(() => {
      const text = [...document.querySelectorAll(".ownership-owner")]
        .map((item) => item.textContent ?? "")
        .join(" ");
      return [
        "Windows 应用安装体系",
        "Windows 用户配置体系",
        "面向全体用户的共享应用配置",
        "卷影复制、还原点和文件系统服务数据",
        "该卷的回收站系统数据",
        "路径与 Windows 约定系统目录精确匹配"
      ].some((value) => text.includes(value));
    })()`);
    if (ownershipRuntimeLeak) {
      throw new Error("Known ownership-map result text remained Chinese in English mode");
    }
    await clickButton("Settings");
    await waitFor('document.querySelector(".settings-page") !== null');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".settings-module-nav button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "Appearance & language");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".language-picker-trigger") !== null');
    await evaluate('document.querySelector(".language-picker-trigger")?.click()');
    await evaluate(`(() => {
      const option = [...document.querySelectorAll(".language-picker-list button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "简体中文");
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    await waitFor('[...document.querySelectorAll(".sidebar-bottom .nav-item span")].some((item) => item.textContent?.trim() === "设置")');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".settings-module-nav button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "索引与快捷操作");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".settings-system-stack") !== null');
    await wait(160);
    await capture("cdriveshiftai-settings-system.png");
  }

  if (requestedView === "search") {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-mode-switch button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "内容搜索");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".content-match-options") !== null');
    await clickButton("选择内容索引目录");
    await waitFor('document.querySelector(".scope-clear-button") !== null');
    await evaluate('document.querySelector(".scope-clear-button")?.click()');
    await waitFor('document.querySelector(".scope-clear-button") === null');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-mode-switch button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "名称搜索");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".search-filter-workbench") !== null');
    await evaluate(`(() => {
      const input = document.querySelector(".search-input-wrap input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "RedScope");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor('document.querySelector(".result-grid-row") !== null');
    await clickButton("更多条件");
    await waitFor('document.querySelector(".advanced-filter-panel") !== null');
    await clickButton("正则匹配");
    await waitFor('document.querySelector(".regex-assistant") !== null');
    await wait(220);
    await capture("cdriveshiftai-search-regex-assistant.png");
    await clickButton("添加书签");
    await waitFor('document.querySelectorAll(".search-bookmark-chip").length === 1');
    await clickButton("晶境");
    await waitFor('document.documentElement.dataset.effect === "calm"');
    await evaluate(`(() => {
      if (document.querySelector(".search-bookmark-dropdown")) return true;
      const toggle = document.querySelector(".search-bookmark-toggle");
      if (!(toggle instanceof HTMLButtonElement)) return false;
      toggle.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".search-bookmark-dropdown") !== null');
    await evaluate(`(() => {
      const rail = document.querySelector(".bookmark-folder-rail");
      if (!rail) return false;
      const bounds = rail.getBoundingClientRect();
      rail.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.right - 30,
        clientY: bounds.top + bounds.height / 2
      }));
      return true;
    })()`);
    await waitFor('document.querySelector(".bookmark-context-menu") !== null');
    await capture("cdriveshiftai-bookmark-folder-menu-crystal.png");
    await clickButton("新建书签文件夹");
    await waitFor('document.querySelector(".bookmark-folder-chip input") !== null');
    await evaluate(`(() => {
      const input = document.querySelector(".bookmark-folder-chip input");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "渗透项目");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    await waitFor('document.querySelector(".bookmark-folder-chip input") === null');
    const allSelected = await evaluate(`(() => {
      const allButton = [...document.querySelectorAll(".bookmark-folder-rail > button")]
        .find((button) => button.textContent?.includes("全部"));
      if (!(allButton instanceof HTMLButtonElement)) return false;
      allButton.click();
      return true;
    })()`);
    if (!allSelected) throw new Error("All bookmarks view was unavailable");
    await waitFor('document.querySelector(".search-bookmark-chip") !== null');
    const bookmarkMoved = await evaluate(`(() => {
      const bookmark = document.querySelector(".search-bookmark-chip");
      const folder = document.querySelector(".bookmark-folder-chip");
      if (!(bookmark instanceof HTMLElement) || !(folder instanceof HTMLElement)) return false;
      const transfer = new DataTransfer();
      bookmark.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      folder.dispatchEvent(new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      folder.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      bookmark.dispatchEvent(new DragEvent("dragend", {
        bubbles: true,
        dataTransfer: transfer
      }));
      return true;
    })()`);
    if (!bookmarkMoved) throw new Error("Bookmark drag test could not run");
    await waitFor('document.querySelector(".bookmark-folder-chip small")?.textContent === "1"');
    await wait(450);
    searchSizeColumn = await evaluate(`[
      ...document.querySelectorAll(".result-columns button")
    ].some((item) => item.textContent?.includes("大小"))`);
    if (!searchSizeColumn) throw new Error("Search result size column was not rendered");
    const columnResize = await evaluate(`(() => {
      const header = document.querySelector(".result-columns button");
      const handle = header?.querySelector(".result-column-resizer");
      if (!header || !handle) return null;
      const headerBounds = header.getBoundingClientRect();
      const handleBounds = handle.getBoundingClientRect();
      return {
        before: headerBounds.width,
        x: handleBounds.left + handleBounds.width / 2,
        y: handleBounds.top + handleBounds.height / 2
      };
    })()`);
    if (!columnResize) throw new Error("Search result column resize handle was not rendered");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: columnResize.x,
      y: columnResize.y,
      button: "left",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: columnResize.x + 48,
      y: columnResize.y,
      button: "left",
      buttons: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: columnResize.x + 48,
      y: columnResize.y,
      button: "left",
      clickCount: 1
    });
    const resizedColumnWidth = await evaluate(
      'document.querySelector(".result-columns button")?.getBoundingClientRect().width'
    );
    if (!(resizedColumnWidth > columnResize.before + 20)) {
      throw new Error(`Search result column did not resize: ${columnResize.before} -> ${resizedColumnWidth}`);
    }
    await capture("cdriveshiftai-search-bookmark-folders.png");
    await evaluate(`(() => {
      if (!document.querySelector(".search-bookmark-dropdown")) return true;
      document.querySelector(".search-bookmark-toggle")?.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".search-bookmark-dropdown") === null');
    const compactBookmarkHeight = await evaluate(
      'document.querySelector(".search-bookmark-strip")?.getBoundingClientRect().height'
    );
    if (!(compactBookmarkHeight <= 44)) {
      throw new Error(`Collapsed bookmark panel is too tall: ${compactBookmarkHeight}`);
    }
    await capture("cdriveshiftai-search-bookmarks-collapsed.png");

    await clickButton("晶境");
    await waitFor('document.documentElement.dataset.effect === "calm"');
    const pathRect = await evaluate(`(() => {
      const path = document.querySelector(".result-path-cell");
      if (!path) return null;
      const bounds = path.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    if (!pathRect) throw new Error("Search result path was unavailable for tooltip test");
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pathRect.x,
      y: pathRect.y
    });
    await waitFor('document.querySelector(".themed-tooltip") !== null', true, 12);
    const pathTooltipLayout = await evaluate(`(() => {
      const path = document.querySelector(".result-path-cell");
      const tooltip = document.querySelector(".themed-tooltip--wrap");
      if (!path || !tooltip) return null;
      const bounds = tooltip.getBoundingClientRect();
      return {
        expected: path.textContent,
        actual: tooltip.querySelector("span")?.textContent,
        overflowX: tooltip.scrollWidth - tooltip.clientWidth,
        right: bounds.right,
        bottom: bounds.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      };
    })()`);
    if (!pathTooltipLayout || pathTooltipLayout.actual !== pathTooltipLayout.expected) {
      throw new Error(`Search result path tooltip did not expose the complete path: ${JSON.stringify(pathTooltipLayout)}`);
    }
    if (pathTooltipLayout.overflowX > 1) {
      throw new Error(`Search result path tooltip still clips horizontally: ${JSON.stringify(pathTooltipLayout)}`);
    }
    if (pathTooltipLayout.right > pathTooltipLayout.viewportWidth + 1 || pathTooltipLayout.bottom > pathTooltipLayout.viewportHeight + 1) {
      throw new Error(`Search result path tooltip escaped the viewport: ${JSON.stringify(pathTooltipLayout)}`);
    }
    await capture("cdriveshiftai-search-result-tooltip-crystal.png");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
    await waitFor('document.querySelector(".themed-tooltip") === null', true, 12);
    await clickButton("方块");
    await waitFor('document.documentElement.dataset.effect === "aurora"');

    const resultRect = await evaluate(`(() => {
      const row = document.querySelector(".result-grid-row");
      if (!row) return null;
      const bounds = row.getBoundingClientRect();
      return { x: bounds.left + bounds.width * 0.42, y: bounds.top + bounds.height / 2 };
    })()`);
    if (!resultRect) throw new Error("Search result row was not available for context-menu test");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await waitFor('document.querySelector(".search-context-menu") !== null');
    await wait(160);
    await capture("cdriveshiftai-search-context-menu.png");
    const forceDeleteClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-context-menu button")]
        .find((item) => item.querySelector("span")?.textContent?.trim() === "强制永久删除…");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!forceDeleteClicked) throw new Error("Force-delete action was unavailable");
    await waitFor('document.querySelector(".force-delete-dialog") !== null');
    await waitFor('document.querySelector(".force-delete-processes") !== null');
    await capture("cdriveshiftai-search-force-delete-preview.png");
    await evaluate('document.querySelector(".force-delete-dialog > header > button")?.click()');
    await waitFor('document.querySelector(".force-delete-dialog") === null');
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await waitFor('document.querySelector(".search-context-menu") !== null');
    const propertiesClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-context-menu button")]
        .find((item) => item.querySelector("span")?.textContent?.trim() === "属性");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!propertiesClicked) throw new Error("Properties action was unavailable");
    await waitFor('document.querySelector(".path-properties-dialog") !== null');
    await waitFor('document.querySelector(".path-properties-metrics") !== null');
    const propertyRenameClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(".path-properties-dialog footer button")]
        .find((item) => item.textContent?.trim() === "重命名");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!propertyRenameClicked) throw new Error("Properties rename action was unavailable");
    await waitFor('document.querySelector(".path-properties-rename input") !== null');
    await evaluate(`(() => {
      const input = document.querySelector(".path-properties-rename input");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "RedScope-renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".path-properties-rename button")]
        .find((item) => item.textContent?.trim() === "确认");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor(
      'document.querySelector(".path-properties-titlebar strong")?.textContent === "RedScope-renamed"'
    );
    await waitFor(
      'document.querySelector(".result-grid-row strong")?.textContent === "RedScope-renamed"'
    );
    for (const [label, effect, fileName] of [
      ["方块", "aurora", "cdriveshiftai-properties-blockworld.png"],
      ["科技", "matrix", "cdriveshiftai-properties-technology.png"],
      ["晶境", "calm", "cdriveshiftai-properties-crystal.png"]
    ]) {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll(".effect-switcher button")]
          .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
      await wait(180);
      await capture(fileName);
    }
    const propertiesHandle = await evaluate(`(() => {
      const header = document.querySelector(".path-properties-titlebar");
      const dialog = document.querySelector(".path-properties-dialog");
      if (!header || !dialog) return null;
      const handle = header.getBoundingClientRect();
      const before = dialog.getBoundingClientRect();
      return {
        x: handle.left + handle.width * 0.42,
        y: handle.top + 25,
        beforeX: before.left,
        beforeY: before.top
      };
    })()`);
    if (!propertiesHandle) throw new Error("Properties drag handle was unavailable");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: propertiesHandle.x,
      y: propertiesHandle.y,
      button: "left",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: propertiesHandle.x + 90,
      y: propertiesHandle.y + 45,
      button: "left",
      buttons: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: propertiesHandle.x + 90,
      y: propertiesHandle.y + 45,
      button: "left",
      clickCount: 1
    });
    await waitFor(`(() => {
      const bounds = document.querySelector(".path-properties-dialog")?.getBoundingClientRect();
      return Boolean(
        bounds &&
        bounds.left > ${JSON.stringify(propertiesHandle.beforeX)} + 40 &&
        bounds.top > ${JSON.stringify(propertiesHandle.beforeY)} + 20
      );
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 14,
      y: 500,
      button: "left",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 14,
      y: 500,
      button: "left",
      clickCount: 1
    });
    await waitFor('document.querySelector(".path-properties-dialog") === null');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".effect-switcher button")]
        .find((item) => item.textContent?.trim() === "方块");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.documentElement.dataset.effect === "aurora"');
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await waitFor('document.querySelector(".search-context-menu") !== null');
    const renameClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-context-menu button")]
        .find((item) => item.querySelector("span")?.textContent?.trim() === "重命名");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!renameClicked) throw new Error("Rename action was unavailable");
    await waitFor('document.querySelector(".context-rename") !== null');
    const dragHandle = await evaluate(`(() => {
      const header = document.querySelector(".context-target.draggable");
      const menu = document.querySelector(".search-context-menu");
      if (!header || !menu) return null;
      const handle = header.getBoundingClientRect();
      const before = menu.getBoundingClientRect();
      return {
        x: handle.left + handle.width / 2,
        y: handle.top + 18,
        beforeX: before.left,
        beforeY: before.top
      };
    })()`);
    if (!dragHandle) throw new Error("Rename drag handle was unavailable");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: dragHandle.x,
      y: dragHandle.y,
      button: "left",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dragHandle.x + 120,
      y: dragHandle.y + 70,
      button: "left",
      buttons: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: dragHandle.x + 120,
      y: dragHandle.y + 70,
      button: "left",
      clickCount: 1
    });
    const movedRename = await evaluate(`(() => {
      const bounds = document.querySelector(".search-context-menu")?.getBoundingClientRect();
      return Boolean(
        bounds &&
        bounds.left > ${JSON.stringify(dragHandle.beforeX)} + 60 &&
        bounds.top > ${JSON.stringify(dragHandle.beforeY)} + 30
      );
    })()`);
    if (!movedRename) throw new Error("Rename window did not move or persist its position");
    const movedRenamePosition = await evaluate(`(() => {
      const menu = document.querySelector(".search-context-menu");
      const bounds = menu?.getBoundingClientRect();
      return bounds ? {
        x: bounds.left,
        y: bounds.top,
        styleLeft: menu.style.left,
        styleTop: menu.style.top,
        sessionPosition: menu.dataset.sessionPosition,
        transform: getComputedStyle(menu).transform,
        computedLeft: getComputedStyle(menu).left,
        position: getComputedStyle(menu).position,
        offsetLeft: menu.offsetLeft,
        count: document.querySelectorAll(".search-context-menu").length
      } : null;
    })()`);
    await capture("cdriveshiftai-search-rename-moved.png");
    await evaluate('document.querySelector(".context-target > button")?.click()');
    await waitFor('document.querySelector(".search-context-menu") === null');
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: resultRect.x,
      y: resultRect.y,
      button: "right",
      clickCount: 1
    });
    await waitFor('document.querySelector(".search-context-menu") !== null');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-context-menu button")]
        .find((item) => item.querySelector("span")?.textContent?.trim() === "重命名");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    await waitFor('document.querySelector(".context-rename") !== null');
    await wait(180);
    const restoredRenamePosition = await evaluate(`(() => {
      const menu = document.querySelector(".search-context-menu");
      const bounds = menu?.getBoundingClientRect();
      return bounds ? {
        x: bounds.left,
        y: bounds.top,
        styleLeft: menu.style.left,
        styleTop: menu.style.top,
        sessionPosition: menu.dataset.sessionPosition
      } : null;
    })()`);
    const renamePositionRestored = Boolean(
      restoredRenamePosition &&
      Math.abs(restoredRenamePosition.x - movedRenamePosition?.x) < 3 &&
      Math.abs(restoredRenamePosition.y - movedRenamePosition?.y) < 3
    );
    if (!renamePositionRestored) {
      throw new Error(
        `Rename window did not restore its last closed position: ${JSON.stringify({
          movedRenamePosition,
          restoredRenamePosition
        })}`
      );
    }
    await evaluate('document.querySelector(".context-target > button")?.click()');
    await wait(520);
    await clickButton("空间总览");
    await waitFor('document.querySelector(".overview-page") !== null');
    await clickButton("极速搜索");
    await waitFor('document.querySelector(".search-page") !== null');
    await waitFor('document.querySelector(".search-input-wrap input")?.value === "RedScope"');
    await waitFor('document.querySelector(".result-grid-row") !== null');
    await waitFor('document.querySelector(".restored-search-state") !== null');
    await wait(520);
    await capture("cdriveshiftai-search-restored.png");
    const contentModeClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(".search-mode-switch button")]
        .find((item) => item.querySelector("strong")?.textContent?.trim() === "内容搜索");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!contentModeClicked) throw new Error("Content search mode button was unavailable");
    await waitFor('document.querySelector(".content-match-options") !== null');
    await clickButton("选择内容索引目录");
    await waitFor('document.querySelector(".scope-clear-button") !== null');
    await evaluate('document.querySelector(".scope-clear-button")?.click()');
    await waitFor('document.querySelector(".scope-clear-button") === null');
    await evaluate(`(() => {
      const input = document.querySelector(".search-input-wrap input");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "error\\\\s+[45]\\\\d{2}");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor('document.querySelector(".regex-assistant") !== null');
    await wait(220);
    await capture("cdriveshiftai-content-regex-assistant.png");
  }

  if (requestedView === "migrate") {
    const pathsReady = await evaluate(`(() => {
      const inputs = [...document.querySelectorAll(".migration-paths input")];
      if (inputs.length < 2) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(inputs[0], "C:\\\\Users\\\\You\\\\PixelProject");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(inputs[1], "D:\\\\Archive");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!pathsReady) throw new Error("Migration path inputs were unavailable");
    await clickButton("执行迁移预检");
    await waitFor('document.querySelector(".preflight-summary") !== null');
    await waitFor(
      'document.querySelector(".preflight-summary")?.textContent?.includes("D:\\\\Archive\\\\PixelProject") === true'
    );
    const confirmed = await evaluate(`(() => {
      const consent = document.querySelector(".consent-row input");
      if (!(consent instanceof HTMLInputElement)) {
        return false;
      }
      consent.click();
      return true;
    })()`);
    if (!confirmed) throw new Error("Migration confirmation controls were unavailable");
    await clickButton("确认并开始安全迁移");
    await waitFor('document.querySelector(".migration-live.stage-copying") !== null');
    await wait(100);
    await capture("cdriveshiftai-migration-progress-blockworld.png");
    await wait(1_150);
    await waitFor('document.querySelector(".migration-live.stage-verifying") !== null');
    await clickButton("科技");
    await waitFor('document.documentElement.dataset.effect === "matrix"');
    await capture("cdriveshiftai-migration-progress-technology.png");
    await wait(1_150);
    await waitFor('document.querySelector(".migration-live.stage-switching") !== null');
    await clickButton("晶境");
    await waitFor('document.documentElement.dataset.effect === "calm"');
    await capture("cdriveshiftai-migration-progress-crystal.png");
    await waitFor('document.querySelector(".migration-live.stage-linked") !== null', true, 20);
    await clickButton("方块");
    await waitFor('document.documentElement.dataset.effect === "aurora"');
    await capture("cdriveshiftai-migration-complete-blockworld.png");
    await clickButton("迁移记录");
    await waitFor('document.querySelector(".history-card") !== null');
    await evaluate('document.querySelector(".history-select input")?.click()');
    await waitFor('document.querySelector(".history-card.selected") !== null');
    await clickButton("删除所选 1");
    await waitFor('document.querySelector(".history-delete-confirm") !== null');
    await capture("cdriveshiftai-history-multi-delete.png");
    await clickButton("确认删除记录");
    await waitFor('document.querySelector(".history-card") === null');
  }

  if (requestedView === "analyze") {
    const changed = await evaluate(`(() => {
      const input = document.querySelector(".analyze-input-card input");
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "C:\\\\Users\\\\tester\\\\.codex");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!changed) throw new Error("Analysis path input was unavailable");
    await clickButton("开始分析");
    await waitFor('document.querySelector(".analysis-hero") !== null');
    await waitFor('document.querySelectorAll(".directory-insight-row").length >= 4');
    await waitFor('document.querySelectorAll(".directory-insight-header span").length === 4');
    await waitFor('document.querySelector(".analysis-saved-note") !== null');
    await wait(220);
    await capture("cdriveshiftai-analyze.png");
    for (const [label, effect, fileName] of [
      ["科技", "matrix", "cdriveshiftai-analyze-technology.png"],
      ["晶境", "calm", "cdriveshiftai-analyze-crystal.png"],
      ["方块", "aurora", "cdriveshiftai-analyze-blockworld.png"]
    ]) {
      await clickButton(label);
      await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
      await wait(140);
      await capture(fileName);
    }
    await waitFor('document.querySelector(".clear-analysis-button") !== null');
    await clickButton("清空当前结果");
    await waitFor('document.querySelector(".analysis-hero") === null');
    await waitFor(
      'document.querySelector(".analyze-input-card input")?.value === ""'
    );
    await wait(160);
    await capture("cdriveshiftai-analyze-cleared.png");
  }

  if (requestedView === "ownership-map") {
    await waitFor('document.querySelectorAll(".ownership-table-head span").length === 4');
    const openOwnershipMenu = async () => {
      await waitFor('document.querySelector(".ownership-row") !== null');
      const rowRect = await evaluate(`(() => {
        const row = document.querySelector(".ownership-row");
        if (!row) return null;
        const bounds = row.getBoundingClientRect();
        return { x: bounds.left + bounds.width * 0.38, y: bounds.top + bounds.height / 2 };
      })()`);
      if (!rowRect) throw new Error("Ownership row was unavailable");
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: rowRect.x,
        y: rowRect.y,
        button: "right",
        clickCount: 1
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: rowRect.x,
        y: rowRect.y,
        button: "right",
        clickCount: 1
      });
      await waitFor('document.querySelector(".ownership-context-menu") !== null');
      await waitFor('document.querySelector(".ownership-row.context-active") !== null');
    };

    const ownershipScenes = [
      ["方块", "aurora", "cdriveshiftai-ownership-menu-blockworld.png"],
      ["科技", "matrix", "cdriveshiftai-ownership-menu-technology.png"],
      ["晶境", "calm", "cdriveshiftai-ownership-menu-crystal.png"]
    ];
    for (const [label, effect, fileName] of ownershipScenes) {
      await clickButton(label);
      await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
      const actionRect = await evaluate(`(() => {
        const button = document.querySelector(".ownership-actions button");
        if (!button) return null;
        const bounds = button.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`);
      if (!actionRect) throw new Error("Ownership hover action was unavailable");
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: actionRect.x,
        y: actionRect.y
      });
      await waitFor('document.querySelector(".themed-tooltip") !== null', true, 12);
      await capture(fileName.replace("-menu-", "-tooltip-"));
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 4,
        y: 4
      });
      await waitFor('document.querySelector(".themed-tooltip") === null', true, 12);
      await openOwnershipMenu();
      await wait(160);
      await capture(fileName);
      await evaluate('document.querySelector(".ownership-context-target > button")?.click()');
      await evaluate(`document.querySelector(".ownership-row")?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true })
      )`);
      await waitFor('document.querySelector(".ownership-row .path-open-feedback") !== null');
      await wait(80);
      await capture(fileName.replace("-menu-", "-double-open-"));
      await wait(1_150);
    }
  }

  await clickButton("AI：仅本地");
  await waitFor('document.querySelector(".settings-page") !== null');
  await evaluate(`(() => {
    const button = [...document.querySelectorAll(".settings-module-nav button")]
      .find((item) => item.querySelector("strong")?.textContent?.trim() === "AI 服务");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  await waitFor('document.querySelector(".ai-provider-panel") !== null');

  await evaluate(`(() => {
    const toggle = document.querySelector(".ai-master input");
    if (!(toggle instanceof HTMLInputElement)) return false;
    if (!toggle.checked) toggle.click();
    return true;
  })()`);
  await waitFor('document.querySelector(".ai-provider-panel:not(.disabled-form)") !== null');
  await evaluate('document.querySelector(".ai-settings")?.scrollIntoView({ block: "start" })');
  await wait(120);

  const providerScenes = [
    ["方块", "aurora", "cdriveshiftai-provider-picker-blockworld.png"],
    ["科技", "matrix", "cdriveshiftai-provider-picker-technology.png"],
    ["晶境", "calm", "cdriveshiftai-provider-picker-crystal.png"]
  ];
  for (const [label, effect, fileName] of providerScenes) {
    await clickButton(label);
    await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
    await evaluate('document.querySelector(".provider-picker-trigger")?.click()');
    await waitFor('document.querySelector(".provider-picker-popover") !== null');
    await wait(140);
    await capture(fileName);
    await evaluate('document.querySelector(".provider-picker-trigger")?.click()');
  }
  await clickButton("方块");
  await waitFor('document.documentElement.dataset.effect === "aurora"');
  await evaluate('document.querySelector(".provider-picker-trigger")?.click()');
  await waitFor('document.querySelector(".provider-picker-popover") !== null');
  await evaluate(`(() => {
    const option = [...document.querySelectorAll(".provider-picker-group > button")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Ollama");
    if (!(option instanceof HTMLButtonElement)) return false;
    option.click();
    return true;
  })()`);
  await waitFor('document.querySelector(".provider-picker-trigger")?.textContent?.includes("Ollama") === true');
  await clickButton("获取/刷新模型");
  await waitFor('document.querySelector(".model-picker > button")?.disabled === false');
  await evaluate('document.querySelector(".model-picker > button")?.click()');
  await waitFor('document.querySelectorAll(".model-picker-option").length >= 3');
  await waitFor('Boolean(document.querySelector(".ai-model-discovery input")?.value)');
  await capture("cdriveshiftai-model-picker.png");
  await evaluate('document.querySelector(".model-picker > button")?.click()');
  await waitFor('document.querySelector(".test-ai-button")?.disabled === false');
  await evaluate('document.querySelector(".test-ai-button")?.scrollIntoView({ block: "center" })');
  await wait(120);
  await evaluate('document.querySelector(".test-ai-button")?.click()');
  await wait(120);
  await waitFor('document.querySelector(".ai-test-result.success") !== null', true, 100);
  await evaluate('document.querySelector(".ai-settings")?.scrollIntoView({ block: "start" })');
  await wait(180);
  await capture("cdriveshiftai-ai-provider-tested.png");
  await evaluate('document.querySelector(".ai-settings-footer")?.scrollIntoView({ block: "end" })');
  await wait(100);
  await waitFor('document.querySelector(".ai-autosave-status.saved") !== null');
  await waitFor('document.querySelector(".ai-master input")?.checked === true');
  await wait(120);
  await capture("cdriveshiftai-ai-provider-saved.png");
  await evaluate('document.querySelector(".settings-page")?.scrollTo({ top: 0 })');
  await evaluate(`(() => {
    const button = document.querySelectorAll(".settings-module-nav button")[1];
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  await waitFor('document.querySelector(".effect-cards") !== null');

  const scenes = [
    ["科技", "matrix", "cdriveshiftai-effect-technology.png"],
    ["晶境", "calm", "cdriveshiftai-effect-crystal.png"],
    ["方块", "aurora", "cdriveshiftai-effect-blockworld.png"]
  ];
  for (const [label, effect, fileName] of scenes) {
    await clickButton(label);
    await waitFor(`document.documentElement.dataset.effect === ${JSON.stringify(effect)}`);
    await wait(180);
    await capture(fileName);
  }

  const result = await evaluate(`({
    effect: document.documentElement.dataset.effect,
    localModeLabel: document.querySelector(".privacy-pill")?.textContent?.trim(),
    settingsVisible: document.querySelector(".settings-page") !== null
  })`);
  console.log(JSON.stringify({ ok: true, ...result, searchSizeColumn }, null, 2));
} finally {
  socket?.close();
  chrome.kill();
  await wait(150);
  await rm(profileDirectory, { recursive: true, force: true });
}
