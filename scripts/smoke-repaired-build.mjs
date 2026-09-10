import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(process.argv[2] ?? path.join(workspace, "artifacts/repaired-build/win-unpacked/CDriveShiftAI.exe"));
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "packaged-"));
await writeFile(path.join(fixture, "cdriveshiftai-state.json"), JSON.stringify({ settings: {
  launchAtLogin: true, launchMinimized: true, mouseQuickSearchButton: "disabled",
  globalShortcut: "", quickSearchShortcut: "", magnifierEnabled: false
} }));
let child;
let timeout;
try {
  const environment = { ...process.env, CDRIVESHIFTAI_DATA_DIR: fixture, CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "1800" };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, ["--startup-minimized"], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Packaged application did not exit within 20 seconds")), 20_000); })
  ]);
  assert.equal(code, 0, errors);
  const logDirectory = path.join(fixture, "logs");
  const logs = await readdir(logDirectory);
  const text = (await Promise.all(logs.filter(name => /\.(log|jsonl)$/.test(name)).map(name => readFile(path.join(logDirectory, name), "utf8")))).join("\n");
  assert.match(text, /application.ready/, "Packaged app did not finish initialization");
  assert.match(text, /application.shutdown_completed/, "Packaged app did not finish graceful shutdown");
  assert.doesNotMatch(text, /application.startup_failed|process.uncaught_exception|process.unhandled_rejection/);
  const state = JSON.parse(await readFile(path.join(fixture, "cdriveshiftai-state.json"), "utf8"));
  assert.equal(state.settings.launchMinimized, true);
  process.stdout.write(JSON.stringify({ result: "ok", executable, packagedStartup: true, gracefulShutdown: true, isolatedJournal: true }, null, 2) + "\n");
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]); }
  assert(path.resolve(fixture).startsWith(temporaryRoot + path.sep));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
