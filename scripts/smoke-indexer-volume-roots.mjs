import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

// Exercise logical volume discovery without requiring USB hardware. SUBST maps
// an unused drive letter to a new directory inside this project's test fixture.
assert.equal(process.platform, "win32");
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "indexer-volume-roots-"));
const backing = path.join(fixture, "volume");
await mkdir(backing);
const system = process.env.SystemRoot ?? "C:\\Windows";
const powershell = path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe");
const subst = path.join(system, "System32/subst.exe");
const executable = path.join(workspace, "native/indexer/target/release/cshift-indexer.exe");
const run = promisify(execFile);
const env = { ...process.env, TEMP: fixture, TMP: fixture, CDRIVESHIFTAI_DISABLE_WATCHERS: "1" };
const commandOptions = { cwd: fixture, env, windowsHide: true, timeout: 10_000 };
const children = [];
let drive;
let createdMapping = false;
const normalized = (value) => path.win32.resolve(value).toLowerCase().replace(/[\\/]+$/, "");

async function logicalDrives() {
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "ConvertTo-Json -InputObject ([Environment]::GetLogicalDrives()) -Compress"], commandOptions);
  return JSON.parse(stdout).map((root) => root.toUpperCase());
}

async function mappingTarget() {
  const { stdout } = await run(subst, [], commandOptions);
  const row = stdout.split(/\r?\n/).find((line) => line.slice(0, 2).toUpperCase() === drive);
  return row?.split(" => ").slice(1).join(" => ").trim();
}

async function startIndexer(sequence) {
  const state = path.join(fixture, `state-${sequence}`);
  await mkdir(state);
  const child = spawn(executable, ["--serve"], { cwd: fixture, env, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiting = new Map();
  let id = 0;
  child.stderr.resume();
  child.stdin.on("error", () => {});
  reader.on("line", (line) => {
    const value = JSON.parse(line);
    waiting.get(value.id)?.(value);
  });
  function request(fields) {
    const key = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(key); reject(Error(`Native ${fields.op} timed out`)); }, 10_000);
      waiting.set(key, (value) => {
        clearTimeout(timer); waiting.delete(key);
        value.ok === false ? reject(Error(value.error)) : resolve(value);
      });
      child.stdin.write(JSON.stringify({ id: key, ...fields }) + "\n");
    });
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await request({ op: "quit" });
    child.stdin.end();
    const [code] = await exited;
    reader.close();
    assert.equal(code, 0);
  };
  children.push({ child, exited, reader });
  const response = await request({ op: "init", root: "*", background: true,
    mouseButton: "disabled", magnifierEnabled: false, cachePath: path.join(state, "names.bin"),
    contentCacheDir: path.join(state, "content") });
  assert(Array.isArray(response.indexedRoots) && response.indexedRoots.length > 0);
  return { roots: response.indexedRoots.map((root) => root.toUpperCase()), stop };
}

try {
  const before = await startIndexer(1);
  const occupied = new Set(await logicalDrives());
  const letter = [..."ZYXWVUTSRQPONMLKJIHG"].find((candidate) => !occupied.has(`${candidate}:\\`));
  assert(letter, "No unused drive letter available for the isolated topology test");
  drive = `${letter}:`;
  assert(!before.roots.includes(`${drive}\\`));
  await run(subst, [drive, backing], commandOptions);
  createdMapping = true;
  assert.equal(normalized(await mappingTarget()), normalized(backing));
  assert((await logicalDrives()).includes(`${drive}\\`));
  await before.stop();

  const attached = await startIndexer(2);
  assert(attached.roots.includes(`${drive}\\`), "Restart did not include the newly attached logical volume");
  await attached.stop();
  assert.equal(normalized(await mappingTarget()), normalized(backing), "The test mapping changed before removal");
  await run(subst, [drive, "/D"], commandOptions);
  createdMapping = false;

  const removed = await startIndexer(3);
  assert(!removed.roots.includes(`${drive}\\`), "Restart retained the removed logical volume");
  await removed.stop();
  console.log(JSON.stringify({ result: "ok", simulatedVolumeAttach: true, rootsUpdatedAfterRestart: true,
    removedVolumeExcludedAfterRestart: true, backgroundedIndexers: true }));
} finally {
  for (const { child, exited, reader } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    reader.close();
  }
  if (createdMapping) {
    const actual = await mappingTarget();
    assert(actual && normalized(actual) === normalized(backing), "The test mapping changed. Preserve it for review.");
    await run(subst, [drive, "/D"], commandOptions);
  }
  assert.equal(path.dirname(fixture), tempRoot);
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
