import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The clean-exit smoke test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "CDriveShiftAI.exe"
);
const dataDirectory = path.join(workspace, ".cdriveshiftai-data");
await access(executable);

const startedAt = performance.now();
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CDRIVESHIFTAI_DATA_DIR: dataDirectory,
    CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "1800"
  }
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const exitResult = await Promise.race([
  once(child, "exit").then(([code]) => ({ code, timedOut: false })),
  new Promise((resolve) =>
    setTimeout(() => resolve({ code: null, timedOut: true }), 12_000)
  )
]);
if (exitResult.timedOut) {
  execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore"
  });
  throw new Error("CDriveShiftAI did not finish graceful shutdown in 12 seconds");
}
await new Promise((resolve) => setTimeout(resolve, 500));

const processAudit = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$root=[System.IO.Path]::GetFullPath($env:CSHIFT_APP_ROOT);",
      "$items=@(Get-CimInstance Win32_Process | Where-Object {",
      "$_.ExecutablePath -and [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(",
      "$root + [System.IO.Path]::DirectorySeparatorChar,",
      "[System.StringComparison]::OrdinalIgnoreCase)} |",
      "Select-Object Name,ProcessId,ParentProcessId,ExecutablePath);",
      "$items | ConvertTo-Json -Compress"
    ].join("")
  ],
  {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      CSHIFT_APP_ROOT: path.dirname(executable)
    }
  }
).trim();
const lingering = processAudit ? JSON.parse(processAudit) : [];
const lingeringList = Array.isArray(lingering) ? lingering : [lingering];

if (exitResult.code !== 0) {
  throw new Error(`CDriveShiftAI exited with code ${exitResult.code}: ${stderr}`);
}
if (/write EPIPE|uncaught exception|javascript error/i.test(stderr)) {
  throw new Error(`CDriveShiftAI emitted a main-process pipe error: ${stderr}`);
}
if (lingeringList.length > 0) {
  throw new Error(`CDriveShiftAI left processes behind: ${JSON.stringify(lingeringList)}`);
}

console.log(
  JSON.stringify(
    {
      result: "ok",
      gracefulExitMs: Math.round(performance.now() - startedAt),
      epipeObserved: false,
      lingeringProcesses: 0
    },
    null,
    2
  )
);
