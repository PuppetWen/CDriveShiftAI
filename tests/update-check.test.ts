import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: { getVersion: () => "0.1.7", isPackaged: true },
    net: {
      fetch: request,
      request: ({ url, redirect }: { url: string; redirect: string }) => {
        const client = new EventEmitter() as InstanceType<typeof EventEmitter> & { setHeader: (name: string, value: string) => void; end: () => void; abort: () => void };
        const headers: Record<string, string> = {};
        client.setHeader = (name, value) => { headers[name] = value; };
        client.abort = () => undefined;
        client.end = () => {
          void request(url, { redirect, headers }).then((response: Response) => {
            if (response.ok) client.emit("redirect", 302, "GET", response.url);
            else client.emit("response", { statusCode: response.status });
          }, (error: Error) => client.emit("error", error));
        };
        return client;
      }
    },
    session: { defaultSession: { resolveProxy: async () => "PROXY 127.0.0.1:7890" } }
  };
});

import { UpdateService } from "../electron/update";

const base = "https://github.com/PuppetWen/CDriveShiftAI/releases";
const manifest = {
  schemaVersion: 1,
  version: "0.1.8",
  assets: {
    installer: { name: "CDriveShiftAI-x64.exe", size: 100, sha512: "a".repeat(128) },
    portable: { name: "CDriveShiftAI-x64-portable.exe", size: 80, sha512: "b".repeat(128) }
  }
};
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const limited = () => json({ message: "API rate limit exceeded" }, 403, {
  "x-ratelimit-remaining": "0",
  "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600)
});
const releasePage = (url = `${base}/tag/v0.1.8`) => Object.defineProperty(new Response("release page"), "url", { value: url });
const redirect = () => releasePage();
const service = () => new UpdateService(() => undefined, async () => undefined);

beforeEach(() => { request.mockReset(); vi.stubEnv("PORTABLE_EXECUTABLE_FILE", ""); });
afterEach(() => vi.unstubAllEnvs());

describe("GitHub release checks through a shared system proxy", () => {
  it("recovers from an exhausted API quota using official, version-pinned release assets", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(manifest));
    const result = await service().check(true);
    expect(result).toMatchObject({ status: "available", latestVersion: "0.1.8", canAutoUpdate: true });
    expect(result.selectedAsset?.downloadUrl).toBe(`${base}/download/v0.1.8/CDriveShiftAI-x64.exe`);
    expect(result.network).toMatchObject({ mode: "system-proxy", label: expect.stringContaining("127.0.0.1:7890") });
    expect(result.message).toContain("官方发布清单");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]).toEqual([
      `${base}/latest`,
      expect.objectContaining({ redirect: "manual", headers: { "User-Agent": "CDriveShiftAI/0.1.7", "Cache-Control": "no-cache" } })
    ]);
    expect(request.mock.calls[2][0]).toBe(`${base}/download/v0.1.8/update-manifest.json`);
  });

  it("respects API cooldown even when the user forces another check", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(manifest));
    const updater = service();
    await updater.check(true);
    expect((await updater.check(true)).status).toBe("available");
    expect(request.mock.calls.filter(([url]) => String(url).startsWith("https://api.github.com/"))).toHaveLength(1);
  });

  it("does not rapidly retry HTTP 429", async () => {
    request.mockResolvedValueOnce(json({}, 429, { "retry-after": "300" }))
      .mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(manifest));
    expect((await service().check(true)).canAutoUpdate).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent startup and Settings checks", async () => {
    let respond!: (value: Response) => void;
    request.mockReturnValueOnce(new Promise<Response>((resolve) => { respond = resolve; }));
    const updater = service();
    const first = updater.check(true);
    const second = updater.check(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    respond(json({ tag_name: "v0.1.7" }));
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual(["current", "current"]);
    await updater.check();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports the actual rate-limit cause if both official channels fail", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await service().check(true);
    expect(result).toMatchObject({ status: "unavailable", canAutoUpdate: false, errorCode: "CHECK_RATE_LIMITED" });
    expect(result.message).toContain("共享限额");
    expect(result.message).toContain("HTTP 404");
  });

  it.each([
    { location: "https://untrusted.example/releases/tag/v0.1.8", name: "another host" },
    { location: `${base}/tag/v0.1.8-beta`, name: "a prerelease tag" },
    { location: `${base}/tag/v0.1.8/other`, name: "another path" }
  ])("rejects fallback redirects to $name", async ({ location }) => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(releasePage(location));
    expect((await service().check(true)).canAutoUpdate).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a manifest that disagrees with its immutable release tag", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(json({ ...manifest, version: "0.1.9" }));
    const result = await service().check(true);
    expect(result.canAutoUpdate).toBe(false);
    expect(result.message).toContain("版本不一致");
  });

  it("rejects unsafe asset filenames before constructing a download destination", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(json({ ...manifest, assets: { ...manifest.assets, installer: { ...manifest.assets.installer, name: "..\\escape.exe" } } }));
    expect((await service().check(true)).canAutoUpdate).toBe(false);
  });

  it("preserves a previously validated update when a later check loses connectivity", async () => {
    request.mockResolvedValueOnce(limited()).mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(manifest))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const updater = service();
    await updater.check(true);
    const result = await updater.check(true);
    expect(result).toMatchObject({ status: "unavailable", updateAvailable: true, canAutoUpdate: true });
    expect(result.selectedAsset?.downloadUrl).toBe(`${base}/download/v0.1.8/CDriveShiftAI-x64.exe`);
  });
});
