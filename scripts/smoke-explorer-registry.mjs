import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Exercise the real registry helper in a unique test namespace. These keys
// cannot appear in Explorer and never overwrite the user's menu registration.
const require = createRequire(import.meta.url);
const { ExplorerContextMenuService, EXPLORER_MENU_KEYS } = require("../dist-electron/explorer-context-menu.js");
const testRoot = "Software\\CDriveShiftAI.Tests\\" + randomUUID();
const powerShell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
const bootstrap = "[Console]::InputEncoding=[Text.UTF8Encoding]::new(); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
function run(script) {
  return new Promise((resolve, reject) => {
    const child = execFile(powerShell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin.on("error", reject);
    child.stdin.end(script);
  });
}
const service = new ExplorerContextMenuService({ isPackaged: false, executablePath: process.execPath,
  appPath: path.resolve(import.meta.dirname, "..") }, {
  runRegistryScript: (script) => {
    for (const [index, key] of EXPLORER_MENU_KEYS.entries()) {
      assert(script.includes(key));
      script = script.replaceAll(key, testRoot + "\\" + index);
    }
    return run(script);
  }
});
try {
  assert.equal((await service.getStatus()).registered, false);
  await assert.rejects(service.withEnabled(true, async () => { throw new Error("simulated settings save failure"); }), /simulated settings save failure/);
  assert.equal((await service.getStatus()).registered, false);
  assert.equal((await service.setEnabled(true)).enabled, true);
  await assert.rejects(service.withEnabled(false, async () => { throw new Error("simulated save failure on disable"); }), /simulated save failure/);
  assert.equal((await service.getStatus()).enabled, true);
  assert.equal((await service.setEnabled(false)).registered, false);
  console.log(JSON.stringify({ ok: true, actualPowerShellRegistryWrites: true, enabledAndRemoved: true,
    saveFailureRestoresExactRegistration: true, isolatedRegistryNamespace: testRoot, userExplorerKeysUnchanged: true }, null, 2));
} finally {
  assert(/^Software\\CDriveShiftAI\.Tests\\[a-f0-9-]{36}$/.test(testRoot));
  await run("$ErrorActionPreference='Stop'; [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('" + testRoot + "',$false)");
}
