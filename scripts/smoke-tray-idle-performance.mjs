import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, link, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The tray performance smoke test requires Windows");
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
const testData = path.join(sourceData, "test-temp", "tray-idle-performance");
const testCache = path.join(testData, "search-index-v1.bin");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

await access(executable);
const cacheStats = await stat(sourceCache);
if (cacheStats.size < 1024) {
  throw new Error("A populated persisted index is required for the tray performance test");
}
await rm(testData, { recursive: true, force: true });
await mkdir(testData, { recursive: true });
await link(sourceCache, testCache);
await writeFile(
  path.join(testData, "cdriveshiftai-state.json"),
  JSON.stringify({
    settings: {
      effectMode: "calm",
      launchAtLogin: true,
      launchMinimized: true,
      minimizeToTray: true
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
        "$owned=@($rows|Where-Object {$_.name -in @('CDriveShiftAI','cshift-indexer','conhost')});",
        "[pscustomobject]@{cpu=(($owned|Measure-Object cpu -Sum).Sum);",
        "working=(($owned|Measure-Object working -Sum).Sum);",
        "private=(($owned|Measure-Object private -Sum).Sum);processes=$owned}",
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

const child = spawn(executable, ["--startup-minimized"], {
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    CDRIVESHIFTAI_DATA_DIR: testData,
    CDRIVESHIFTAI_TRIM_DIAGNOSTICS: "1",
    CDRIVESHIFTAI_SMOKE_CLOSE_TO_TRAY_AFTER_READY_MS: "8000",
    CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "20000"
  }
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  // The real cache currently contains millions of entries. Eight seconds lets
  // the cooperative cache loader reach ready before the app follows its normal
  // close-to-tray path; two more seconds lets Chromium release the renderer.
  await wait(10_000);
  const before = processTreeSnapshot(child.pid);
  await wait(5_000);
  const after = processTreeSnapshot(child.pid);
  const elapsedSeconds = 5;
  const coreEquivalentPct = ((after.cpu - before.cpu) / elapsedSeconds) * 100;
  const taskManagerPct =
    coreEquivalentPct / (Number(process.env.NUMBER_OF_PROCESSORS) || 1);
  const renderers = after.processes.filter((item) =>
    /--type=renderer(?:\s|$)/i.test(item.commandLine ?? "")
  );
  const indexer = after.processes.find((item) => item.name === "cshift-indexer");
  const metrics = {
    result: "ok",
    cacheBytes: cacheStats.size,
    idleCoreEquivalentPct: Number(coreEquivalentPct.toFixed(2)),
    idleTaskManagerPct: Number(taskManagerPct.toFixed(2)),
    workingSetMB: Number((after.working / 1024 ** 2).toFixed(1)),
    privateMemoryMB: Number((after.private / 1024 ** 2).toFixed(1)),
    rendererProcesses: renderers.length,
    indexerPresent: Boolean(indexer),
    trimDiagnostics: stderr.trim(),
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
  if (!indexer) throw new Error("Tray mode stopped the native indexer");
  if (renderers.length > 0) {
    throw new Error(`Tray mode retained ${renderers.length} renderer process(es)`);
  }
  if (coreEquivalentPct > 5) {
    throw new Error(`Tray idle CPU is too high: ${coreEquivalentPct.toFixed(2)}% of one core`);
  }
  if (after.working > 450 * 1024 ** 2) {
    throw new Error(`Tray process tree working set is too high: ${metrics.workingSetMB} MB`);
  }

  const secondInstance = spawn(executable, [], {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, CDRIVESHIFTAI_DATA_DIR: testData }
  });
  await Promise.race([
    once(secondInstance, "exit"),
    wait(3_000).then(() => {
      throw new Error("Second application instance did not hand off to the tray process");
    })
  ]);
  await wait(1_500);
  const reopened = processTreeSnapshot(child.pid);
  const reopenedRenderers = reopened.processes.filter((item) =>
    /--type=renderer(?:\s|$)/i.test(item.commandLine ?? "")
  );
  if (reopenedRenderers.length === 0) {
    throw new Error("Launching CDriveShiftAI again did not recreate the tray window");
  }
  console.log(
    JSON.stringify(
      {
        result: "reopen-ok",
        reopenedRendererProcesses: reopenedRenderers.length
      },
      null,
      2
    )
  );

  await Promise.race([
    once(child, "exit"),
    wait(12_000).then(() => {
      throw new Error("Application did not complete its timed graceful shutdown");
    })
  ]);
  if (/write EPIPE|uncaught exception|javascript error/i.test(stderr)) {
    throw new Error(`Main process emitted a tray/shutdown error: ${stderr}`);
  }
} finally {
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
