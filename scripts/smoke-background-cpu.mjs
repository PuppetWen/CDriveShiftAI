import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const executable = path.join(
  workspace,
  "native",
  "indexer",
  "target",
  "release",
  "cshift-indexer.exe"
);
const dataRoot = path.join(workspace, ".cdriveshiftai-data");
const cachePath = path.join(dataRoot, "background-cpu-smoke.bin");
const contentCacheDir = path.join(dataRoot, "background-content-smoke");

await access(executable);
const child = spawn(executable, ["--serve"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
let nextId = 0;
const pending = new Map();

lines.on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.id == null) return;
  const handler = pending.get(value.id);
  if (!handler) return;
  pending.delete(value.id);
  handler(value);
});

function request(payload) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request ${id} timed out`));
    }, 10_000);
    pending.set(id, (value) => {
      clearTimeout(timer);
      value.ok === false ? reject(new Error(value.error)) : resolve(value);
    });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

function snapshot() {
  const command = [
    `$p=Get-Process -Id ${child.pid} -ErrorAction Stop;`,
    "[pscustomobject]@{",
    "cpu=$p.TotalProcessorTime.TotalSeconds;",
    "working=$p.WorkingSet64;",
    "private=$p.PrivateMemorySize64",
    "}|ConvertTo-Json -Compress"
  ].join("");
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true
    })
  );
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function measure(label, milliseconds = 5_000) {
  const before = snapshot();
  const startedAt = performance.now();
  await delay(milliseconds);
  const after = snapshot();
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const coreEquivalent = ((after.cpu - before.cpu) / elapsedSeconds) * 100;
  return {
    phase: label,
    coreEquivalentPct: Number(coreEquivalent.toFixed(2)),
    taskManagerPct: Number(
      (coreEquivalent / (Number(process.env.NUMBER_OF_PROCESSORS) || 1)).toFixed(2)
    ),
    workingSetMB: Number((after.working / 1024 ** 2).toFixed(1)),
    privateMB: Number((after.private / 1024 ** 2).toFixed(1))
  };
}

try {
  await request({
    op: "init",
    root: "*",
    cachePath,
    contentCacheDir,
    forceRebuild: true,
    background: true
  });
  await delay(750);
  const initiallyPaused = await measure("initial-background");
  await request({ op: "setBackground", background: false });
  await delay(1_000);
  const foreground = await measure("foreground-rebuild");
  await request({ op: "setBackground", background: true });
  await delay(1_000);
  const pausedAgain = await measure("background-paused-again");
  console.log(JSON.stringify([initiallyPaused, foreground, pausedAgain], null, 2));

  if (
    initiallyPaused.coreEquivalentPct > 2 ||
    pausedAgain.coreEquivalentPct > 2 ||
    foreground.coreEquivalentPct < 5
  ) {
    throw new Error("background CPU suspension assertion failed");
  }
} finally {
  try {
    await request({ op: "quit" });
  } catch {
    child.kill();
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_500).then(() => child.kill())
  ]);
  for (const candidate of [
    cachePath,
    path.join(dataRoot, "background-cpu-smoke.delta"),
    path.join(dataRoot, "background-cpu-smoke.tmp")
  ]) {
    if (path.dirname(candidate) === dataRoot) {
      await rm(candidate, { force: true });
    }
  }
}
