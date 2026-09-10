import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ directory: "", encryptionAvailable: true, failRename: false }));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString()
  }
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => {
    if (fixture.failRename) return Promise.reject(Object.assign(new Error("disk write failed"), { code: "EACCES" }));
    return actual.rename(...args);
  } };
});
import { AppStore } from "../electron/store";
import type { MigrationRecord } from "../electron/types";

beforeEach(async () => {
  const root = path.resolve(".test-tmp");
  await mkdir(root, { recursive: true });
  fixture.directory = await mkdtemp(path.join(root, "store-"));
  fixture.encryptionAvailable = true;
  fixture.failRename = false;
});
afterEach(async () => { await rm(fixture.directory, { recursive: true, force: true }); });
const filename = () => path.join(fixture.directory, "cdriveshiftai-state.json");
const record = (id: string): MigrationRecord => ({ id, source: `C:\\Apps\\${id}`, destination: `D:\\Apps\\${id}`,
  stage: "linked", totalBytes: 2, copiedBytes: 2, startedAt: "2026-01-01", updatedAt: "2026-01-01", warnings: [] });

describe("durable settings and migration journal", () => {
  it("keeps Explorer integration opt-in, normalizes invalid flags and persists explicit changes", async () => {
    await writeFile(filename(), JSON.stringify({ settings: { forceDeleteContextMenu: "true" } }));
    const store = new AppStore(); await store.init();
    expect(store.getSettings().forceDeleteContextMenu).toBe(false);
    await store.updateSettings({ forceDeleteContextMenu: true });
    const restarted = new AppStore(); await restarted.init();
    expect(restarted.getSettings().forceDeleteContextMenu).toBe(true);
    await restarted.updateSettings({ forceDeleteContextMenu: false });
    expect(JSON.parse(await readFile(filename(), "utf8")).settings.forceDeleteContextMenu).toBe(false);
  });
  it("preserves corrupt and invalid state rather than silently overwriting the journal", async () => {
    for (const content of ["{broken", "null", "[]", JSON.stringify({ migrations: { app: {} } }), JSON.stringify({ migrations: [{ ...record("app"), stage: "unknown" }] })]) {
      await writeFile(filename(), content);
      await expect(new AppStore().init()).rejects.toThrow("原文件已保留");
      expect(await readFile(filename(), "utf8")).toBe(content);
    }
  });
  it("does not publish failed encrypted settings in memory or in a later write", async () => {
    const store = new AppStore(); await store.init();
    fixture.encryptionAvailable = false;
    await expect(store.updateSettings({ effectMode: "matrix", apiKey: "test-key" })).rejects.toThrow("未保存");
    expect(store.getSettings().effectMode).toBe("aurora");
    await store.saveMigration(record("app"));
    expect(JSON.parse(await readFile(filename(), "utf8")).settings.effectMode).toBe("aurora");
  });
  it("rolls back failed disk writes and lets following changes commit", async () => {
    const store = new AppStore(); await store.init();
    fixture.failRename = true;
    await expect(store.updateSettings({ effectMode: "matrix" })).rejects.toThrow("disk write failed");
    expect(store.getSettings().effectMode).toBe("aurora");
    fixture.failRename = false;
    await store.updateSettings({ uiScale: 1.5 });
    const restarted = new AppStore(); await restarted.init();
    expect(restarted.getSettings()).toMatchObject({ effectMode: "aurora", uiScale: 1.5 });
  });
  it("serializes overlapping settings and migration writes without losing updates", async () => {
    const store = new AppStore(); await store.init();
    await Promise.all([store.updateSettings({ effectMode: "matrix" }), store.updateSettings({ uiScale: 2 }), store.saveMigration(record("app"))]);
    await store.whenIdle();
    const restarted = new AppStore(); await restarted.init();
    expect(restarted.getSettings()).toMatchObject({ effectMode: "matrix", uiScale: 2 });
    expect(restarted.listMigrations()).toHaveLength(1);
  });
  it("keeps all restorable migrations and rollback staging paths on restart", async () => {
    const records = Array.from({ length: 2001 }, (_, i) => ({ ...record(String(i)), restorePath: `C:\\restore-${i}` }));
    await writeFile(filename(), JSON.stringify({ migrations: records }));
    const store = new AppStore(); await store.init();
    expect(store.listMigrations()).toHaveLength(2001);
    expect(store.getMigration("0")?.restorePath).toBe("C:\\restore-0");
  });
  it("normalizes malformed settings without leaking arbitrary properties", async () => {
    await writeFile(filename(), JSON.stringify({ settings: { launchAtLogin: "false", minimizeToTray: "false", indexRoots: [null, "D:\\"], injected: 123,
      ai: { privacyMode: "allow-samples", model: null } } }));
    const store = new AppStore(); await store.init();
    expect(store.getSettings()).toMatchObject({ launchAtLogin: false, minimizeToTray: true, indexRoots: ["D:\\"], ai: { model: "", privacyMode: "allow-samples" } });
    expect(store.getSettings()).not.toHaveProperty("injected");
  });
});
