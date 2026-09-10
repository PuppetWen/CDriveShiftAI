import { describe, expect, it, vi } from "vitest";
import {
  buildExplorerCommand,
  EXPLORER_MENU_KEYS,
  ExplorerContextMenuService,
  type ExplorerContextMenuOptions
} from "../electron/explorer-context-menu";

const options: ExplorerContextMenuOptions = {
  platform: "win32",
  isPackaged: true,
  executablePath: "E:\\安装的应用\\CDriveShiftAI\\CDriveShiftAI.exe"
};

const absent = () => ({ exists: false, command: "", ownerExecutable: "", label: "", icon: "", multiSelectModel: "" });
type State = ReturnType<typeof absent>;
type Snapshot = { Exists: boolean; Tree: unknown };
interface Request {
  operation: string;
  registration: { command: string; executable: string; label: string; icon: string; multiSelectModel: string };
  snapshots?: Snapshot[];
}

function requestFrom(script: string): Request {
  const payload = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  if (!payload) throw new Error("Helper did not encode its data");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function registry(initial: State[] = [absent(), absent()]) {
  let states = structuredClone(initial);
  const requests: Request[] = [];
  const runner = vi.fn(async (script: string) => {
    const request = requestFrom(script);
    requests.push(request);
    if (request.operation === "enable") states = [0, 1].map(() => ({ exists: true, command: request.registration.command, ownerExecutable: request.registration.executable, label: request.registration.label, icon: request.registration.icon, multiSelectModel: request.registration.multiSelectModel }));
    if (request.operation === "disable") states = [absent(), absent()];
    if (request.operation === "restore") states = request.snapshots!.map((snapshot) => snapshot.Exists ? structuredClone(snapshot.Tree as State) : absent());
    return JSON.stringify({ keys: states, ...(request.operation === "snapshot" ? { snapshots: states.map((state) => ({ Exists: state.exists, Tree: state.exists ? structuredClone(state) : null })) } : {}) });
  });
  return { requests, runner, states: () => states };
}

describe("Explorer force delete command", () => {
  it("quotes Unicode paths and launches the installed executable directly", () => {
    expect(buildExplorerCommand(options)).toBe('"E:\\安装的应用\\CDriveShiftAI\\CDriveShiftAI.exe" --force-delete-path "%1"');
  });

  it("uses the portable launcher rather than its temporary extraction executable", () => {
    expect(buildExplorerCommand({ ...options, executablePath: "C:\\Temp\\extract\\CDriveShiftAI.exe", portableExecutablePath: "E:\\便携版\\CDriveShiftAI portable.exe" }))
      .toBe('"E:\\便携版\\CDriveShiftAI portable.exe" --force-delete-path "%1"');
  });

  it("includes the development application directory with valid trailing-backslash escaping", () => {
    expect(buildExplorerCommand({ ...options, isPackaged: false, executablePath: "E:\\node modules\\electron.exe", appPath: "E:\\项目\\" }))
      .toBe('"E:\\node modules\\electron.exe" "E:\\项目\\\\" --force-delete-path "%1"');
  });

  it("retains shell metacharacters as data in quoted paths", () => {
    const command = buildExplorerCommand({ ...options, executablePath: "E:\\a & b\\'$test`(;x)\\CDriveShiftAI.exe" });
    expect(command).toBe('"E:\\a & b\\\'$test`(;x)\\CDriveShiftAI.exe" --force-delete-path "%1"');
    expect(command).not.toMatch(/(?:cmd|powershell)\.exe/i);
  });

  it.each(["relative.exe", "C:relative.exe", "\\rooted.exe", 'E:\\app" --evil.exe', "E:\\app.exe\n", "\\\\?\\E:\\app.exe", "\\\\.\\pipe\\x.exe", "E:\\*.exe", "E:\\app.cmd"])("rejects malformed executable %j", (executablePath) => {
    expect(() => buildExplorerCommand({ ...options, executablePath })).toThrow();
  });

  it("requires an absolute development app path", () => {
    expect(() => buildExplorerCommand({ ...options, isPackaged: false, appPath: "." })).toThrow("开发项目路径");
  });

  it("allows a fully qualified UNC executable", () => {
    expect(buildExplorerCommand({ ...options, executablePath: "\\\\server\\apps\\CDriveShiftAI.exe" }))
      .toBe('"\\\\server\\apps\\CDriveShiftAI.exe" --force-delete-path "%1"');
  });
});

describe("Explorer force delete registration", () => {
  it("reads actual keys without changing the registry", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    expect(await service.getStatus()).toEqual({ supported: true, enabled: false, registered: false, needsRepair: false, command: undefined });
    expect(fake.requests.map((request) => request.operation)).toEqual(["read"]);
  });

  it("enables both file and directory entries and removes only the dedicated keys", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    expect(await service.setEnabled(true)).toMatchObject({ supported: true, enabled: true, registered: true, needsRepair: false });
    expect(fake.states().every((state) => state.command.endsWith('--force-delete-path "%1"'))).toBe(true);
    expect(await service.setEnabled(false)).toMatchObject({ supported: true, enabled: false, registered: false });
    const script = fake.runner.mock.calls[0][0];
    for (const key of EXPLORER_MENU_KEYS) expect(script).toContain(`'${key}'`);
    expect(script).toContain("[Microsoft.Win32.Registry]::CurrentUser");
    expect(script).not.toContain("Registry]::LocalMachine");
  });

  it("detects and repairs an old executable path or a partially removed registration", async () => {
    const old = { ...absent(), exists: true, command: '"D:\\Old\\CDriveShiftAI.exe" --force-delete-path "%1"', ownerExecutable: "D:\\Old\\CDriveShiftAI.exe" };
    const fake = registry([old, absent()]);
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    expect(await service.getStatus()).toMatchObject({ registered: true, enabled: false, needsRepair: true, command: old.command });
    expect(await service.setEnabled(true)).toMatchObject({ registered: true, enabled: true, needsRepair: false });
  });

  it("returns unsupported without invoking Windows tools on other platforms", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService({ ...options, platform: "linux", executablePath: "/usr/bin/app" }, { runRegistryScript: fake.runner });
    expect(await service.getStatus()).toEqual({ supported: false, enabled: false, registered: false, needsRepair: false });
    await expect(service.setEnabled(true)).rejects.toThrow("仅支持 Windows");
    expect(fake.runner).not.toHaveBeenCalled();
  });

  it("rejects untyped renderer values without reading or writing keys", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    await expect(service.setEnabled("false" as unknown as boolean)).rejects.toThrow("布尔值");
    expect(fake.runner).not.toHaveBeenCalled();
  });

  it("restores exact preexisting menu data when saving settings fails", async () => {
    const original = [{ ...absent(), exists: true, command: '"D:\\Previous version.exe" --force-delete-path "%1"', ownerExecutable: "D:\\Previous version.exe", label: "previous label" }, absent()];
    const fake = registry(original);
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    await expect(service.withEnabled(true, async () => { throw new Error("settings disk is full"); })).rejects.toThrow("settings disk is full");
    expect(fake.states()).toEqual(original);
    expect(fake.requests.map((request) => request.operation)).toEqual(["snapshot", "enable", "restore"]);
  });

  it("restores removed entries when a disabling transaction fails", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    await service.setEnabled(true);
    const original = structuredClone(fake.states());
    await expect(service.withEnabled(false, async () => { throw new Error("runtime failed"); })).rejects.toThrow("runtime failed");
    expect(fake.states()).toEqual(original);
  });

  it("runs configuration commit only after the menu has been verified", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    const result = await service.withEnabled(true, async () => {
      expect(fake.states().every((state) => state.exists)).toBe(true);
      return { saved: true };
    });
    expect(result).toEqual({ saved: true });
    expect(fake.requests.map((request) => request.operation)).toEqual(["snapshot", "enable"]);
  });

  it("does not run configuration commit after a registration write failure", async () => {
    const fake = registry();
    fake.runner.mockImplementationOnce(async (script) => JSON.stringify({ keys: [absent(), absent()], snapshots: requestFrom(script).operation === "snapshot" ? [{ Exists: false, Tree: null }, { Exists: false, Tree: null }] : undefined }));
    fake.runner.mockRejectedValueOnce(new Error("Access denied; previous registration restored"));
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    const commit = vi.fn(async () => undefined);
    await expect(service.withEnabled(true, commit)).rejects.toThrow("Access denied");
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports both the original configuration failure and a failed rollback", async () => {
    const fake = registry();
    const normal = fake.runner.getMockImplementation()!;
    fake.runner.mockImplementation(async (script) => {
      if (requestFrom(script).operation === "restore") throw new Error("registry access revoked");
      return normal(script);
    });
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    await expect(service.withEnabled(false, async () => { throw new Error("settings failure"); })).rejects.toThrow(/settings failure.*还原原有右键菜单失败.*registry access revoked/);
  });

  it("serializes rapid toggles and state reads until configuration commit completes", async () => {
    const fake = registry();
    const service = new ExplorerContextMenuService(options, { runRegistryScript: fake.runner });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const commitStarted = new Promise<void>((resolve) => { started = resolve; });
    const first = service.withEnabled(true, async () => { started(); await gate; });
    await commitStarted;
    const second = service.setEnabled(false);
    const read = service.getStatus();
    await Promise.resolve();
    expect(fake.requests.map((request) => request.operation)).toEqual(["snapshot", "enable"]);
    release();
    await first;
    expect(await second).toMatchObject({ registered: false });
    expect(await read).toMatchObject({ registered: false });
  });

  it.each(["not json", "{}", '{"keys":[]}', '{"keys":[{},{}]}'])("rejects an invalid registry response %s", async (result) => {
    const service = new ExplorerContextMenuService(options, { runRegistryScript: async () => result });
    await expect(service.getStatus()).rejects.toThrow("无法检查右键强制删除菜单");
  });

  it("keeps special path characters out of executable PowerShell source", async () => {
    const fake = registry();
    const executablePath = "E:\\a'; $exploit = (123); '#\\CDriveShiftAI.exe";
    const service = new ExplorerContextMenuService({ ...options, executablePath }, { runRegistryScript: fake.runner });
    await service.getStatus();
    const script = fake.runner.mock.calls[0][0];
    expect(script).not.toContain(executablePath);
    expect(script).not.toContain("$exploit");
    expect(requestFrom(script).registration.executable).toBe(executablePath);
  });
});
