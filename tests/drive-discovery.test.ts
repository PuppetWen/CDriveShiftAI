import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ discover: vi.fn(), statfs: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: fixture.discover
  });
  return { ...actual, execFile };
});
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), statfs: fixture.statfs
}));

import { getLocalDriveIdentity, getLocalDriveRoots, invalidateDriveDiscovery } from "../electron/system";

beforeEach(() => {
  invalidateDriveDiscovery();
  fixture.discover.mockReset();
  fixture.statfs.mockReset().mockResolvedValue({ blocks: 100, bsize: 4096, bavail: 50 });
});

describe("readable drive discovery", () => {
  it("refreshes inserted drives immediately and excludes a drive removed during discovery", async () => {
    fixture.discover.mockResolvedValueOnce({ stdout: JSON.stringify([
      { DeviceID: "C:", FileSystem: "NTFS", VolumeSerialNumber: "one" },
      { DeviceID: "E:", FileSystem: "NTFS", VolumeSerialNumber: "two" },
      { DeviceID: "R:", FileSystem: "exFAT", VolumeSerialNumber: "usb" }
    ]) });
    fixture.statfs.mockImplementation(async (root: string) => {
      if (root === "R:\\") throw new Error("Device removed");
      return { blocks: 100, bsize: 4096, bavail: 50 };
    });
    expect(await getLocalDriveRoots()).toEqual(["C:\\", "E:\\"]);
    expect(fixture.discover.mock.calls[0][1].join(" ")).toContain("DriveType=3 OR DriveType=2");
    expect(await getLocalDriveRoots()).toEqual(["C:\\", "E:\\"]);
    expect(fixture.discover).toHaveBeenCalledTimes(1);

    invalidateDriveDiscovery();
    fixture.discover.mockResolvedValueOnce({ stdout: JSON.stringify([
      { DeviceID: "C:", FileSystem: "NTFS", VolumeSerialNumber: "one" },
      { DeviceID: "E:", FileSystem: "NTFS", VolumeSerialNumber: "two" },
      { DeviceID: "R:", FileSystem: "exFAT", VolumeSerialNumber: "usb" }
    ]) });
    fixture.statfs.mockResolvedValue({ blocks: 100, bsize: 4096, bavail: 50 });
    expect(await getLocalDriveRoots()).toEqual(["C:\\", "E:\\", "R:\\"]);
    expect(fixture.discover).toHaveBeenCalledTimes(2);
  });

  it("detects replacement media using the same drive letter", async () => {
    fixture.discover.mockResolvedValueOnce({ stdout: JSON.stringify({
      DeviceID: "R:", FileSystem: "exFAT", VolumeSerialNumber: "old-usb"
    }) });
    const previous = await getLocalDriveIdentity();
    invalidateDriveDiscovery();
    fixture.discover.mockResolvedValueOnce({ stdout: JSON.stringify({
      DeviceID: "R:", FileSystem: "exFAT", VolumeSerialNumber: "new-usb"
    }) });
    expect(await getLocalDriveIdentity()).not.toBe(previous);
    expect(await getLocalDriveRoots()).toEqual(["R:\\"]);
  });
});
