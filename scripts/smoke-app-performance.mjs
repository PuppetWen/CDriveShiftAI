import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The packaged performance smoke test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "CDriveShiftAI.exe"
);
const sourceData = path.join(workspace, ".cdriveshiftai-data");
const sourceCache = path.join(sourceData, "search-index-v1.bin");
const testData = path.join(sourceData, "test-temp", "app-performance");
const testCache = path.join(testData, "search-index-v1.bin");
const debugPort = 9357;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

await access(executable);
const cacheStats = await stat(sourceCache);
if (cacheStats.size < 1024) {
  throw new Error("A populated persisted index is required for the performance smoke test");
}
await rm(testData, { recursive: true, force: true });
await mkdir(testData, { recursive: true });
await link(sourceCache, testCache);
await writeFile(
  path.join(testData, "cdriveshiftai-state.json"),
  JSON.stringify({
    settings: {
      effectMode: "calm",
      minimizeToTray: false
    }
  }),
  "utf8"
);
await utimes(testCache, cacheStats.atime, new Date());

function processTreeSnapshot(rootPid) {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$rootPid=[int]$env:CSHIFT_ROOT_PID;",
        "$all=@(Get-CimInstance Win32_Process);",
        "$ids=[System.Collections.Generic.HashSet[int]]::new();",
        "$null=$ids.Add($rootPid);",
        "do{$before=$ids.Count;foreach($p in $all){",
        "if($ids.Contains([int]$p.ParentProcessId)){$null=$ids.Add([int]$p.ProcessId)}}",
        "}while($ids.Count -gt $before);",
        "$rows=@();foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;",
        "if($p){$meta=$all|Where-Object ProcessId -eq $id|Select-Object -First 1;",
        "$rows+=[pscustomobject]@{name=$p.ProcessName;pid=$p.Id;commandLine=$meta.CommandLine;",
        "cpu=$p.TotalProcessorTime.TotalSeconds;working=$p.WorkingSet64;",
        "private=$p.PrivateMemorySize64}}};",
        "[pscustomobject]@{cpu=(($rows|Measure-Object cpu -Sum).Sum);",
        "working=(($rows|Measure-Object working -Sum).Sum);",
        "private=(($rows|Measure-Object private -Sum).Sum);processes=$rows}",
        "|ConvertTo-Json -Depth 4 -Compress"
      ].join("")
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CSHIFT_ROOT_PID: String(rootPid) }
    }
  );
  return JSON.parse(output);
}

async function fetchPage() {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((candidate) => candidate.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError ?? new Error("Electron renderer target was unavailable");
}

const launchedAt = performance.now();
const child = spawn(
  executable,
  [`--remote-debugging-port=${debugPort}`, "--no-first-run"],
  {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      CDRIVESHIFTAI_DATA_DIR: testData,
      CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "30000"
    }
  }
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

let socket;
try {
  const page = await fetchPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('.app-shell'))")) break;
    await wait(50);
  }
  const uiReadyMs = Math.round(performance.now() - launchedAt);
  // Test runners do not always receive foreground activation. Exercise the
  // same show path as the tray/global shortcut so the cooperative index loader
  // is intentionally resumed for the foreground benchmark.
  await evaluate(
    "window.cDriveShiftAI?.navigateApp?.({view:'overview'}).catch(() => undefined)"
  );
  if (process.env.CDRIVESHIFTAI_DISABLE_VISUAL_EFFECTS === "1") {
    await evaluate(
      "document.querySelectorAll('.background-fx,.fx-surface').forEach((node) => { node.style.display = 'none'; }); document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important;backdrop-filter:none!important;filter:none!important}</style>')"
    );
  }

  let indexer;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    indexer = await evaluate(
      "window.cDriveShiftAI?.indexerStatus?.().catch(() => undefined)"
    );
    if (indexer?.state === "ready") break;
    await wait(125);
  }
  const indexReadyMs = Math.round(performance.now() - launchedAt);
  if (indexer?.state !== "ready" || indexer.entries <= 0) {
    throw new Error(`Persisted index did not become ready: ${JSON.stringify(indexer)}`);
  }

  await wait(6_500);
  const before = processTreeSnapshot(child.pid);
  const sampleStartedAt = performance.now();
  await wait(5_000);
  const after = processTreeSnapshot(child.pid);
  const elapsedSeconds = (performance.now() - sampleStartedAt) / 1_000;
  const coreEquivalentPct = ((after.cpu - before.cpu) / elapsedSeconds) * 100;
  const taskManagerPct =
    coreEquivalentPct / (Number(process.env.NUMBER_OF_PROCESSORS) || 1);
  const deltaStats = await stat(path.join(testData, "search-index-v1.delta")).catch(
    () => ({ size: 0 })
  );
  const metrics = {
    result: "ok",
    uiReadyMs,
    indexReadyMs,
    indexMode: indexer.mode,
    indexEntries: indexer.entries,
    idleCoreEquivalentPct: Number(coreEquivalentPct.toFixed(2)),
    idleTaskManagerPct: Number(taskManagerPct.toFixed(2)),
    workingSetMB: Number((after.working / 1024 ** 2).toFixed(1)),
    privateMemoryMB: Number((after.private / 1024 ** 2).toFixed(1)),
    watcherDeltaBytes: deltaStats.size,
    processes: after.processes.map((item) => {
      const previous = before.processes.find((candidate) => candidate.pid === item.pid);
      return {
        name: item.name,
        pid: item.pid,
        commandLine: item.commandLine,
        coreEquivalentPct: Number(
          (((item.cpu - (previous?.cpu ?? item.cpu)) / elapsedSeconds) * 100).toFixed(2)
        ),
        workingSetMB: Number((item.working / 1024 ** 2).toFixed(1))
      };
    })
  };
  console.log(JSON.stringify(metrics, null, 2));
  if (uiReadyMs > 5_000) throw new Error(`First UI took ${uiReadyMs} ms`);
  if (indexReadyMs > 20_000) throw new Error(`Persisted index took ${indexReadyMs} ms`);
  if (coreEquivalentPct > 25) {
    throw new Error(`Visible idle CPU is too high: ${coreEquivalentPct.toFixed(2)}% of one core`);
  }
  if (after.working > 1_600 * 1024 ** 2) {
    throw new Error(`Process tree working set is too high: ${metrics.workingSetMB} MB`);
  }
  await evaluate("window.close()");
  await Promise.race([
    once(child, "exit"),
    wait(5_000).then(() => {
      throw new Error("Application did not exit after its main window closed");
    })
  ]);
  if (/write EPIPE|uncaught exception|javascript error/i.test(stderr)) {
    throw new Error(`Main process emitted a shutdown error: ${stderr}`);
  }
} finally {
  socket?.close();
  if (child.exitCode == null) {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
  }
  await utimes(sourceCache, cacheStats.atime, cacheStats.mtime);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(testData, { recursive: true, force: true });
      break;
    } catch {
      await wait(250);
    }
  }
}
