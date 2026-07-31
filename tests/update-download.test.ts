import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.1",
    isPackaged: true,
    quit: () => undefined
  }
}));

import { UpdateService } from "../electron/update";

interface DownloadAttempt {
  downloadAttempt(
    url: string,
    partialPath: string,
    total: number,
    attempt: number,
    signal: AbortSignal
  ): Promise<void>;
}

const fixtureRoot = path.join(
  process.cwd(),
  ".cdriveshiftai-data",
  "test-temp",
  "update-download-tests"
);
const payload = Buffer.alloc(512 * 1024, 0x5a);
let server: Server | undefined;

async function listen(
  handler: Parameters<typeof createServer>[0]
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}/package.exe`;
}

function downloader(): DownloadAttempt {
  return new UpdateService(() => undefined, async () => undefined) as unknown as DownloadAttempt;
}

beforeEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("auto-update downloader", () => {
  it("resumes a partially downloaded package with an HTTP Range request", async () => {
    let requests = 0;
    let resumedFrom = -1;
    const url = await listen((request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(200, { "Content-Length": payload.length });
        response.flushHeaders();
        // Wait until Node has handed the first half to the local socket before
        // simulating a broken connection. Destroying on a fixed short timer can
        // race before fetch receives the headers and creates the .part file.
        response.write(payload.subarray(0, payload.length / 2), () => {
          setTimeout(() => response.socket?.destroy(), 50);
        });
        return;
      }
      const match = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ""));
      resumedFrom = match ? Number(match[1]) : -1;
      response.writeHead(206, {
        "Content-Length": payload.length - resumedFrom,
        "Content-Range": `bytes ${resumedFrom}-${payload.length - 1}/${payload.length}`
      });
      response.end(payload.subarray(resumedFrom));
    });
    const partialPath = path.join(fixtureRoot, "package.exe.part");
    const service = downloader();
    await expect(
      service.downloadAttempt(
        url,
        partialPath,
        payload.length,
        1,
        new AbortController().signal
      )
    ).rejects.toBeDefined();
    const partialBytes = (await stat(partialPath)).size;
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(payload.length);

    await service.downloadAttempt(
      url,
      partialPath,
      payload.length,
      2,
      new AbortController().signal
    );
    expect(resumedFrom).toBe(partialBytes);
    expect(await readFile(partialPath)).toEqual(payload);
  });

  it("restarts safely when a server ignores the Range header", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { "Content-Length": payload.length });
      response.end(payload);
    });
    const partialPath = path.join(fixtureRoot, "package.exe.part");
    await writeFile(partialPath, payload.subarray(0, 32_000));
    await downloader().downloadAttempt(
      url,
      partialPath,
      payload.length,
      2,
      new AbortController().signal
    );
    expect((await stat(partialPath)).size).toBe(payload.length);
    expect(await readFile(partialPath)).toEqual(payload);
  });
});
