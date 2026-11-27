import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { SEARCH_SUPERSEDED } from "../electron/search-scheduler";

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(), drives: vi.fn(), access: vi.fn(), stat: vi.fn(), lstat: vi.fn(), readdir: vi.fn(),
  roots: ["C:\\", "E:\\"], holdQuit: false, holdInit: false
}));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: (name: string) => {
  if (name === "userData") return process.cwd();
  if (name === "home") return "C:\\Users\\Tester";
  throw new Error("Unknown folder");
} } }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: fixture.spawn
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), access: fixture.access, stat: fixture.stat,
  lstat: fixture.lstat, readdir: fixture.readdir
}));
vi.mock("../electron/system", async (original) => ({
  ...await original<typeof import("../electron/system")>(), getLocalDriveRoots: fixture.drives
}));
import { SearchService } from "../electron/search";

class IndexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly pid = 100 + processes.length;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  releaseQuit?: () => void;
  releaseInit?: () => void;
  readonly stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    this.requests.push(request);
    if (request.op === "init") {
      const initialize = () => {
        this.respond({ id: request.id, ok: true, indexedRoots: [...fixture.roots] });
        this.respond({ event: "status", status: { state: "ready", mode: "cached", entries: 20,
          progress: 1, root: "本机所有磁盘" } });
      };
      if (fixture.holdInit) this.releaseInit = initialize;
      else initialize();
    } else if (request.op === "quit") {
      this.respond({ id: request.id, ok: true });
      if (fixture.holdQuit) this.releaseQuit = () => this.finish();
      else queueMicrotask(() => this.finish());
    } else if (request.op !== "query") {
      this.respond({ id: request.id, ok: true });
    }
    callback();
  } });

  respond(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  finish() {
    if (this.exitCode != null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
  }
  kill() { this.killed = true; this.finish(); return true; }
}

const processes: IndexProcess[] = [];
const services: SearchService[] = [];
function service() {
  const value = new SearchService(() => undefined, () => undefined, () => undefined, () => undefined,
    { button: "forward", holdMs: 4_000 }, { enabled: true, modifiers: "Alt", width: 640, height: 360 });
  services.push(value);
  return value;
}
beforeEach(() => {
  processes.length = 0;
  fixture.roots = ["C:\\", "E:\\"];
  fixture.holdQuit = false;
  fixture.holdInit = false;
  fixture.spawn.mockReset().mockImplementation(() => {
    expect(processes.filter(child => child.exitCode == null)).toHaveLength(0);
    const child = new IndexProcess();
    processes.push(child);
    return child;
  });
  fixture.drives.mockReset().mockImplementation(async () => [...fixture.roots]);
  fixture.access.mockReset().mockResolvedValue(undefined);
  fixture.stat.mockReset().mockImplementation(async () => ({ mtimeMs: Date.now() }));
  fixture.lstat.mockReset().mockResolvedValue({ size: 3, mtime: new Date(1_000), isFile: () => true });
  fixture.readdir.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  fixture.holdQuit = false;
  for (const child of processes) child.releaseQuit?.();
  for (const value of services.splice(0)) await value.stop();
});

describe("shared indexer drive refresh", () => {
  it("leaves a matching drive set running across repeated focus checks", async () => {
    const value = service();
    await value.start();
    fixture.drives.mockResolvedValue(["e:/", "c:/"]);
    expect(await value.refreshDrives()).toBe(false);
    expect(await value.refreshDrives()).toBe(false);
    expect(processes).toHaveLength(1);
    expect(processes[0].requests.some(request => request.op === "quit")).toBe(false);
  });

  it("shares initial startup with a focus refresh and repeated ordinary start requests", async () => {
    const value = service();
    const starting = value.start();
    const refresh = value.refreshDrives();
    await Promise.all([starting, refresh, value.start()]);
    expect(processes).toHaveLength(1);
    expect(await refresh).toBe(false);
  });

  it("avoids restarting an initial child when drive discovery began before startup", async () => {
    const value = service();
    let releaseDrives!: (roots: string[]) => void;
    fixture.drives.mockImplementationOnce(() => new Promise<string[]>((resolve) => { releaseDrives = resolve; }));
    const refresh = value.refreshDrives();
    await value.start();
    releaseDrives([...fixture.roots]);
    expect(await refresh).toBe(false);
    expect(processes).toHaveLength(1);
  });

  it("restarts once for a newly inserted drive, preserves settings and serves provisional scoped results", async () => {
    const value = service();
    await value.start();
    fixture.roots = ["C:\\", "E:\\", "Q:\\"];
    fixture.holdQuit = true;
    const refreshing = value.refreshDrives();
    await vi.waitFor(() => expect(processes[0].releaseQuit).toBeTypeOf("function"));
    expect(value.refreshDrives(true)).toBe(refreshing);
    const ordinaryStart = value.start();
    fixture.readdir.mockImplementation(async (root: string) => root === "Q:\\" ? [{ name: "needle.txt",
      isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }] : []);
    const page = await value.searchPage("needle", { kind: "file", scope: "Q:\\" }, {}, 2);
    expect(page.items.map(item => item.path)).toEqual(["Q:\\needle.txt"]);
    expect(page.partial).toBe(true);
    await value.configureMouseShortcut("back", 5_000);
    await value.configureMagnifier(true, "Ctrl", 700, 400);
    value.setBackgroundMode(true);
    fixture.holdQuit = false;
    processes[0].releaseQuit!();
    expect(await refreshing).toBe(true);
    await ordinaryStart;
    expect(processes).toHaveLength(2);
    expect(processes[1].requests.find(request => request.op === "init")).toMatchObject({
      root: "*", mouseButton: "back", mouseHoldMs: 5_000, magnifierModifiers: "Ctrl",
      magnifierWidth: 700, magnifierHeight: 400, background: true
    });
    expect(await value.refreshDrives()).toBe(false);
  });

  it("forces a single refresh for replacement media reusing a drive letter and cancels old queries cleanly", async () => {
    const value = service();
    await value.start();
    const query = value.searchPage("pending", { kind: "all", scope: "E:\\" }, {}, 7).catch(error => error);
    const refresh = value.refreshDrives(true);
    expect(value.refreshDrives(true)).toBe(refresh);
    expect(await refresh).toBe(true);
    expect((await query).message).toBe(SEARCH_SUPERSEDED);
    expect(processes).toHaveLength(2);
    expect(processes[1].requests.find(request => request.op === "init")).toMatchObject({ forceRebuild: true });
  });

  it("coalesces duplicate device events while the replacement indexer is initializing", async () => {
    const value = service();
    await value.start();
    fixture.holdInit = true;
    const refresh = value.refreshDrives(true);
    await vi.waitFor(() => expect(processes[1]?.releaseInit).toBeTypeOf("function"));
    expect(value.refreshDrives(true)).toBe(refresh);
    fixture.holdInit = false;
    processes[1].releaseInit!();
    expect(await refresh).toBe(true);
    expect(processes).toHaveLength(2);
  });

  it("retains a forced cache rebuild until an indexer initializes successfully", async () => {
    const value = service();
    await value.start();
    fixture.access.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await value.refreshDrives(true);
    expect(value.getStatus().state).toBe("error");
    expect(processes).toHaveLength(1);
    await value.start();
    expect(processes[1].requests.find(request => request.op === "init")).toMatchObject({ forceRebuild: true });
  });

  it("ends a drive refresh quietly if shutdown interrupts replacement initialization", async () => {
    const value = service();
    await value.start();
    fixture.holdInit = true;
    const refresh = value.refreshDrives(true);
    await vi.waitFor(() => expect(processes[1]?.releaseInit).toBeTypeOf("function"));
    await value.stop();
    expect(await refresh).toBe(false);
    expect(processes).toHaveLength(2);
    expect(processes.every(child => child.exitCode === 0)).toBe(true);
  });

  it("does not spawn a replacement if application shutdown overlaps a drive restart", async () => {
    const value = service();
    await value.start();
    fixture.roots = ["C:\\", "E:\\", "Q:\\"];
    fixture.holdQuit = true;
    const refresh = value.refreshDrives();
    await vi.waitFor(() => expect(processes[0].releaseQuit).toBeTypeOf("function"));
    const stopping = value.stop();
    fixture.holdQuit = false;
    processes[0].releaseQuit!();
    await stopping;
    expect(await refresh).toBe(false);
    expect(processes).toHaveLength(1);
    expect(await value.refreshDrives(true)).toBe(false);
  });
});
