import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeResponse } from "../electron/types";
import { LatestSearchScheduler, SEARCH_SUPERSEDED } from "../electron/search-scheduler";

const filesystem = vi.hoisted(() => ({ lstat: vi.fn(), readdir: vi.fn(), getPath: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: filesystem.getPath } }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), lstat: filesystem.lstat, readdir: filesystem.readdir }));
import { SearchService } from "../electron/search";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const filters = { kind: "all" as const, scope: "*" };
const nativeHit = { name: "alpha.txt", path: "E:\\fixture\\alpha.txt", isDirectory: false, size: 3, score: 1, source: "native-index" };
const downloads = "C:\\Users\\Lenovo\\Downloads";
const portable = `${downloads}\\CEV-Windows-x64-P2P-Test-Portable`;
function entry(name: string, directory = false) {
  return { name, isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory };
}
function service() {
  const value = new SearchService(() => undefined, () => undefined, () => undefined, () => undefined,
    { button: "disabled", holdMs: 3_000 }, { enabled: false, modifiers: "Ctrl", width: 200, height: 200 });
  const internals = value as unknown as { child?: unknown; status: { state: string }; request: ReturnType<typeof vi.fn>; handleLine(line: string): void };
  internals.child = {};
  internals.status = { state: "ready" };
  internals.request = vi.fn().mockResolvedValue({ results: [nativeHit], hasMore: false, generation: 1 });
  return { value, internals };
}
beforeEach(() => {
  filesystem.lstat.mockReset().mockResolvedValue({ size: 3, mtime: new Date(1_000), isFile: () => true });
  filesystem.readdir.mockReset().mockResolvedValue([]);
  filesystem.getPath.mockReset().mockImplementation((name: string) => {
    if (name === "downloads") return downloads;
    if (name === "home") return "C:\\Users\\Lenovo";
    if (name === "userData") return process.cwd();
    throw new Error("No such known folder");
  });
});

describe("latest search scheduling and idle filesystem work", () => {
  it("runs only the active and final pending query in a typing burst, without enriching stale hits", async () => {
    const { value, internals } = service();
    const firstResponse = deferred<NativeResponse>();
    internals.request.mockImplementationOnce(() => firstResponse.promise);
    const first = value.searchPage("a", filters, {}, 7).catch(error => error);
    const middle = value.searchPage("al", filters, {}, 7).catch(error => error);
    const last = value.searchPage("alpha", filters, {}, 7);
    expect(internals.request).toHaveBeenCalledTimes(1);
    expect((await middle).message).toBe(SEARCH_SUPERSEDED);
    firstResponse.resolve({ ok: true, results: [nativeHit], generation: 1 });
    expect((await first).message).toBe(SEARCH_SUPERSEDED);
    expect((await last).items).toHaveLength(1);
    expect(internals.request).toHaveBeenCalledTimes(2);
    expect(filesystem.lstat).toHaveBeenCalledTimes(1);
  });

  it("reuses metadata briefly and invalidates it when the index changes", async () => {
    const { value, internals } = service();
    await value.searchPage("alpha", filters, {}, 7);
    await value.searchPage("alph", filters, {}, 7);
    expect(filesystem.lstat).toHaveBeenCalledTimes(1);
    internals.handleLine(JSON.stringify({ event: "indexChanged", changedCount: 1 }));
    await value.searchPage("alpha", filters, {}, 7);
    expect(filesystem.lstat).toHaveBeenCalledTimes(2);
  });

  it("returns provisional Downloads matches on C: while the first native index is building", async () => {
    const { value, internals } = service();
    internals.status = { state: "indexing" };
    filesystem.readdir.mockImplementation(async (directory: string) => {
      if (directory === downloads) return [entry("CEV-Windows-x64-P2P-Test-Portable", true)];
      if (directory === portable) return [entry("CEV.exe"), entry("CEVCore.dll")];
      return [];
    });
    const page = await value.searchPage("CEV", { kind: "all", scope: "C:/", scopes: ["C:/"] });
    expect(filesystem.readdir.mock.calls[0][0]).toBe(downloads);
    expect(page.items.map((item) => item.path)).toContain(`${portable}\\CEV.exe`);
    expect(page.partial).toBe(true);
    expect(page.totalMatches).toBeUndefined();
    expect(internals.request).not.toHaveBeenCalled();

    internals.handleLine(JSON.stringify({ event: "status", status: { state: "ready", entries: 20 } }));
    internals.request.mockResolvedValueOnce({ results: [{ ...nativeHit, path: `${portable}\\CEV.exe`, name: "CEV.exe" }], totalMatches: 1, generation: 1 });
    const indexed = await value.searchPage("CEV", { kind: "all", scope: "C:/", scopes: ["C:/"] });
    expect(internals.request).toHaveBeenCalledWith(expect.objectContaining({ scope: "C:\\", scopes: ["C:\\"] }), expect.any(Number));
    expect(indexed.items.map((item) => item.path)).toEqual([`${portable}\\CEV.exe`]);
    expect(indexed.partial).not.toBe(true);
    expect(indexed.totalMatches).toBe(1);

    internals.handleLine(JSON.stringify({ event: "status", status: { state: "indexing", entries: 0 } }));
    filesystem.readdir.mockClear();
    await value.searchPage("CEV", { kind: "all", scope: "C:\\" });
    expect(filesystem.readdir).not.toHaveBeenCalled();
  });

  it("honors multiple folder scopes and combined name filters during startup", async () => {
    const { value, internals } = service();
    internals.status = { state: "idle" };
    filesystem.readdir.mockImplementation(async (directory: string) => {
      if (directory === portable) return [entry("CEV.txt"), entry("CEV.exe"), entry("CEV2.exe")];
      if (directory === "E:\\Scope") return [entry("Other.exe"), entry("CEV-missing-size.exe")];
      return [];
    });
    filesystem.lstat.mockImplementation(async (file: string) => ({
      size: file.endsWith("CEV-missing-size.exe") ? 1 : 3, mtime: new Date(3_000), isFile: () => true
    }));
    const page = await value.searchPage("CEV Other", {
      kind: "file", scope: portable, scopes: [`${portable}\\`, "E:/Scope/"], keywords: ["CEV", "Other"], wholeWord: true,
      categories: ["executable"], extensions: ["exe"], minSize: 3, modifiedAfter: new Date(2_000).toISOString(),
      sortBy: "name", sortDirection: "desc"
    });
    expect(page.items.map((item) => item.path)).toEqual(["E:\\Scope\\Other.exe", `${portable}\\CEV.exe`]);
    expect(filesystem.readdir.mock.calls.map(([directory]) => directory)).toEqual([portable, "E:\\Scope"]);
    expect(page.partial).toBe(true);
  });

  it("uses content-index metadata without a filesystem stat per result", async () => {
    const { value, internals } = service();
    internals.request.mockResolvedValue({ results: [{ ...nativeHit, preview: "alpha", modifiedAtMs: 2_000 }], generation: 1 });
    const page = await value.searchContentPage("alpha", "E:\\fixture", {}, 7);
    expect(page.items[0].modifiedAt).toBe(new Date(2_000).toISOString());
    expect(filesystem.lstat).not.toHaveBeenCalled();
  });

  it("does not run native searches or directory scans while hidden", async () => {
    const { value, internals } = service();
    value.setBackgroundMode(true);
    internals.request.mockClear();
    expect((await value.searchPage("alpha", filters, {}, 7)).items).toEqual([]);
    expect(await value.directorySizes(["E:\\fixture"], 7)).toEqual([]);
    await expect(value.directorySizes(["E:\\fixture"], 7, "properties")).rejects.toThrow("目录统计已暂停");
    expect(internals.request).not.toHaveBeenCalled();
    expect(filesystem.readdir).not.toHaveBeenCalled();
  });

  it("aborts directory enumeration when the owning window is hidden", async () => {
    const { value } = service();
    const directory = deferred<unknown[]>();
    filesystem.readdir.mockReturnValueOnce(directory.promise);
    const pending = value.directorySizes(["E:\\fixture"], 7).catch(error => error);
    value.cancelWindowSearch(7);
    directory.resolve([{ name: "alpha.txt", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }]);
    expect((await pending).message).toBe(SEARCH_SUPERSEDED);
    expect(filesystem.lstat).not.toHaveBeenCalled();
  });

  it("reuses complete directory counts but invalidates them after a filesystem event", async () => {
    const { value, internals } = service();
    expect((await value.directorySizes(["E:\\fixture"], 7))[0].complete).toBe(true);
    await value.directorySizes(["E:\\fixture"], 7);
    expect(filesystem.readdir).toHaveBeenCalledTimes(1);
    internals.handleLine(JSON.stringify({ event: "indexChanged", changedCount: 1 }));
    await value.directorySizes(["E:\\fixture"], 7);
    expect(filesystem.readdir).toHaveBeenCalledTimes(2);
  });

  it("does not cache directory counts canceled during the final file stat", async () => {
    const { value, internals } = service();
    const metadata = deferred<{ size: number }>();
    filesystem.readdir.mockResolvedValueOnce([entry("alpha.txt")]);
    filesystem.lstat.mockReturnValueOnce(metadata.promise);
    const sizes = value.directorySizes(["E:\\fixture"], 7).catch(error => error);
    await vi.waitFor(() => expect(filesystem.lstat).toHaveBeenCalledOnce());

    internals.request.mockResolvedValueOnce({ results: [], hasMore: false, generation: 1 });
    await value.searchPage("alpha", filters, {}, 7);
    metadata.resolve({ size: 3 });
    expect((await sizes).message).toBe(SEARCH_SUPERSEDED);

    const cache = (value as unknown as { directorySizeCache: Map<string, unknown> }).directorySizeCache;
    expect(cache.size).toBe(0);
    const refreshed = await value.directorySizes(["E:\\fixture"], 7);
    expect(refreshed[0].bytes).toBe(0);
    expect(filesystem.readdir).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a partial search count for an explicitly opened properties dialog", async () => {
    const { value } = service();
    const cache = (value as unknown as { directorySizeCache: Map<string, unknown> }).directorySizeCache;
    cache.set("e:\\fixture", { expiresAt: Date.now() + 2_000,
      result: { path: "E:\\fixture", bytes: 0, files: 0, directories: 1, complete: false } });
    const results = await value.directorySizes(["E:\\fixture"], 7, "properties");
    expect(results[0].complete).toBe(true);
    expect(filesystem.readdir).toHaveBeenCalledOnce();
  });

  it("cancels pending work without a polling timer or affecting another window", async () => {
    const scheduler = new LatestSearchScheduler();
    const running = deferred<number>();
    const current = scheduler.run("one", () => running.promise).catch(error => error);
    const skipped = vi.fn().mockResolvedValue(2);
    const pending = scheduler.run("one", skipped).catch(error => error);
    scheduler.cancel("one");
    expect((await pending).message).toBe(SEARCH_SUPERSEDED);
    expect(await scheduler.run("two", async () => 3)).toBe(3);
    running.resolve(1);
    expect((await current).message).toBe(SEARCH_SUPERSEDED);
    expect(skipped).not.toHaveBeenCalled();
  });
});
