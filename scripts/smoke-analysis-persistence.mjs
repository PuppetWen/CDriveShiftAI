import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "CDriveShiftAI.exe"
);
const testRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
const dataDirectory = path.join(testRoot, "analysis-persistence-data");
const fixture = path.join(testRoot, "analysis-persistence-fixture");
await rm(dataDirectory, { recursive: true, force: true });
await rm(fixture, { recursive: true, force: true });
await mkdir(path.join(fixture, "cache"), { recursive: true });
await writeFile(
  path.join(fixture, "portable-app.config.json"),
  '{"application":"PortableSmokeApp"}',
  "utf8"
);
await writeFile(path.join(fixture, "cache", "state.log"), "ready", "utf8");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 100) {
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
    let page;
    let lastError;
    for (let attempt = 0; attempt < 140; attempt += 1) {
      try {
        const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 1);
        page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (page) break;
      } catch (error) {
        lastError = error;
      }
      await wait(100);
    }
    if (!page?.webSocketDebuggerUrl) {
      throw lastError ?? new Error("Electron page target was unavailable");
    }
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
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      }
      return response.result?.value;
    };
    await send("Runtime.enable");
    for (let attempt = 0; attempt < 100; attempt += 1) {
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
  const first = await withApplication(9251, async (evaluate) => {
    const result = await evaluate(
      `window.cDriveShiftAI.analyzeDirectory(${JSON.stringify(fixture)}, false)`
    );
    const saved = await evaluate(
      `window.cDriveShiftAI.getSavedAnalysis(${JSON.stringify(fixture)})`
    );
    const last = await evaluate("window.cDriveShiftAI.getLastAnalysis()");
    return { result, saved, last };
  });
  if (!first.saved?.snapshot?.analyzedAt || first.last?.summary?.path !== fixture) {
    throw new Error("Analysis was not immediately available from the persistent store");
  }

  const state = JSON.parse(
    await readFile(path.join(dataDirectory, "cdriveshiftai-state.json"), "utf8")
  );
  if (
    state.analyses?.length !== 1 ||
    state.analyses[0]?.summary?.path !== fixture ||
    !state.analyses[0]?.purpose
  ) {
    throw new Error("Analysis result was not written to the project data state");
  }

  const restoredAndDeleted = await withApplication(9252, async (evaluate) => {
    const restoredPath = await evaluate(
      "window.cDriveShiftAI.getLastAnalysis().then((value) => value?.summary?.path)"
    );
    const deleted = await evaluate(
      `window.cDriveShiftAI.deleteSavedAnalysis(${JSON.stringify(fixture)})`
    );
    const savedAfterDelete = await evaluate(
      `window.cDriveShiftAI.getSavedAnalysis(${JSON.stringify(fixture)})`
    );
    return { restoredPath, deleted, savedAfterDelete };
  });
  if (restoredAndDeleted.restoredPath !== fixture) {
    throw new Error("Saved analysis was not restored after application restart");
  }
  if (restoredAndDeleted.deleted !== true || restoredAndDeleted.savedAfterDelete != null) {
    throw new Error("Saved analysis was not cleared from the persistent store");
  }

  const lastAfterRestart = await withApplication(9253, (evaluate) =>
    evaluate("window.cDriveShiftAI.getLastAnalysis()")
  );
  if (lastAfterRestart != null) {
    throw new Error("Cleared analysis reappeared after application restart");
  }

  console.log(
    JSON.stringify(
      {
        result: "ok",
        persistedInsideProject: true,
        restoredAfterRestart: true,
        clearedAndStayedCleared: true,
        purposeSaved: Boolean(first.saved.purpose),
        confidenceSaved: first.saved.confidence
      },
      null,
      2
    )
  );
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}
