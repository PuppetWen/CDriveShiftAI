import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "CDriveShiftAI.exe"
);
const testRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
const dataDirectory = path.join(testRoot, "ownership-persistence-data");
await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

async function withApplication(debugPort, task) {
  const child = spawn(
    executable,
    [`--remote-debugging-port=${debugPort}`, "--no-first-run"],
    {
      env: { ...process.env, CDRIVESHIFTAI_DATA_DIR: dataDirectory },
      stdio: "ignore",
      windowsHide: true
    }
  );
  let socket;
  try {
    const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = pages.find((candidate) => candidate.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("Electron page target was unavailable");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text
        );
      }
      return response.result?.value;
    };
    await send("Runtime.enable");
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await evaluate('Boolean(window.cDriveShiftAI && document.querySelector(".app-shell"))')) {
        return await task(evaluate);
      }
      await wait(100);
    }
    throw new Error("Application API did not become ready");
  } finally {
    socket?.close();
    child.kill();
    await wait(800);
  }
}

try {
  const first = await withApplication(9255, async (evaluate) => {
    const result = await evaluate('window.cDriveShiftAI.scanOwnershipMap("C:\\\\")');
    const saved = await evaluate(
      'window.cDriveShiftAI.getSavedOwnershipMap("C:\\\\")'
    );
    return { result, saved };
  });
  if (
    !first.result?.scannedAt ||
    first.saved?.scannedAt !== first.result.scannedAt ||
    first.saved?.entries?.length !== first.result.entries?.length
  ) {
    throw new Error("Ownership map was not immediately saved");
  }

  const state = JSON.parse(
    await readFile(path.join(dataDirectory, "cdriveshiftai-state.json"), "utf8")
  );
  if (
    state.ownershipMaps?.length !== 1 ||
    state.ownershipMaps[0]?.scannedAt !== first.result.scannedAt
  ) {
    throw new Error("Ownership map was not written to the project data state");
  }

  const restoredRun = await withApplication(9256, async (evaluate) => {
    const restored = await evaluate(
      'window.cDriveShiftAI.getSavedOwnershipMap("C:\\\\")'
    );
    const ui = await evaluate(`(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("磁盘归属地图"))
        ?.click();
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const meta = document.querySelector(".ownership-scan-meta")?.textContent ?? "";
        if (document.querySelector(".ownership-row") && meta.includes("已恢复上次结果")) {
          return {
            restoredLabel: true,
            rowCount: document.querySelectorAll(".ownership-row").length,
            loading: Boolean(document.querySelector(".ownership-loading")),
            buttonText: document.querySelector(".ownership-map-page .primary-button")?.textContent
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        restoredLabel: false,
        rowCount: document.querySelectorAll(".ownership-row").length,
        loading: Boolean(document.querySelector(".ownership-loading")),
        meta: document.querySelector(".ownership-scan-meta")?.textContent
      };
    })()`);
    const afterUi = await evaluate(
      'window.cDriveShiftAI.getSavedOwnershipMap("C:\\\\")'
    );
    return { restored, ui, afterUi };
  });
  const { restored, ui, afterUi } = restoredRun;
  if (
    restored?.scannedAt !== first.result.scannedAt ||
    restored?.entries?.length !== first.result.entries?.length ||
    afterUi?.scannedAt !== first.result.scannedAt ||
    !ui?.restoredLabel ||
    ui.loading ||
    ui.buttonText?.includes("正在")
  ) {
    throw new Error(
      `Ownership map was not restored without rescanning: ${JSON.stringify(ui)}`
    );
  }

  console.log(
    JSON.stringify(
      {
        result: "ok",
        drive: restored.drive,
        entries: restored.entries.length,
        scannedAt: restored.scannedAt,
        persistedInsideProject: true,
        restoredAfterRestart: true,
        uiRestoredWithoutRescan: true
      },
      null,
      2
    )
  );
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
