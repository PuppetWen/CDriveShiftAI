import { describe, expect, it } from "vitest";
import { createForceDeleteLaunchData, ForceDeleteLaunchQueue, parseForceDeleteLaunch } from "../electron/force-delete-launch";

describe("Explorer deletion request routing", () => {
  it("accepts a quoted argument as literal data including Unicode and shell punctuation", () => {
    const target = "E:\\资料 $(whoami) & work\\[draft];x.txt";
    expect(parseForceDeleteLaunch(["app.exe", "--force-delete-path", target])).toBe(target);
  });
  it("ignores ordinary launches", () => {
    expect(parseForceDeleteLaunch(["app.exe", "--startup-minimized"])).toBeUndefined();
  });
  it("retains the original target when Electron moves it after its internal switch", () => {
    const target = "E:\\资料 $(whoami) & work\\[draft];x.txt";
    const data = createForceDeleteLaunchData(["app.exe", "--force-delete-path", target]);
    const reordered = ["app.exe", "--force-delete-path", "--original-process-start-time=12345", target];
    expect(data).toEqual({ forceDeleteArgv: ["--force-delete-path", target] });
    expect(() => parseForceDeleteLaunch(reordered)).toThrow();
    expect(parseForceDeleteLaunch(reordered, JSON.parse(JSON.stringify(data)))).toBe(target);
  });
  it("sends only deletion arguments and uses metadata even when argv has no usable target", () => {
    const target = "E:\\second.txt";
    const data = createForceDeleteLaunchData(["app.exe", "app", "--startup-minimized", "--force-delete-path", target]);
    expect(data).toEqual({ forceDeleteArgv: ["--force-delete-path", target] });
    expect(parseForceDeleteLaunch([], data)).toBe(target);
    expect(parseForceDeleteLaunch(["--force-delete-path", "E:\\wrong.txt"], data)).toBe(target);
  });
  it("keeps ordinary launches ordinary when empty request metadata is provided", () => {
    const data = createForceDeleteLaunchData(["app.exe", "--startup-minimized"]);
    expect(data).toEqual({ forceDeleteArgv: [] });
    expect(parseForceDeleteLaunch(["--force-delete-path", "E:\\unexpected.txt"], data)).toBeUndefined();
    expect(createForceDeleteLaunchData(["app.exe", "--uninstall-restore"])).toEqual(data);
  });
  it("accepts old launchers without request metadata", () => {
    const argv = ["app.exe", "--force-delete-path", "E:\\legacy.txt"];
    expect(parseForceDeleteLaunch(argv, {})).toBe("E:\\legacy.txt");
    expect(parseForceDeleteLaunch(argv, undefined)).toBe("E:\\legacy.txt");
  });
  it.each([
    null, "E:\\file.txt", [],
    { forceDeleteArgv: undefined }, { forceDeleteArgv: "E:\\file.txt" },
    { forceDeleteArgv: ["--force-delete-path", 123] },
    { forceDeleteArgv: ["--force-delete-path", ""] },
    { forceDeleteArgv: ["--force-delete-path", "E:\\file.txt", "--confirm"] },
    { forceDeleteArgv: ["--confirm", "E:\\file.txt"] },
    { forceDeleteArgv: ["--force-delete-path", "x".repeat(32_769)] },
    { forceDeleteArgv: ["--force-delete-path", "relative.txt"] }
  ].map((data) => ({ data })))("rejects malformed metadata without falling back to valid argv: $data", ({ data }) => {
    expect(() => parseForceDeleteLaunch(["--force-delete-path", "E:\\fallback.txt"], data)).toThrow();
  });
  it.each([
    ["--force-delete-path"],
    ["--force-delete-path", "E:\\one", "--force-delete-path", "E:\\two"],
    ["--force-delete-path", "--force-delete-path", "E:\\two"]
  ].map((argv) => [argv]))("preserves invalid original arguments across the process handoff: %j", (argv) => {
    const data = createForceDeleteLaunchData(argv);
    expect(() => parseForceDeleteLaunch(["--force-delete-path", "E:\\fallback.txt"], data)).toThrow();
  });
  it.each([
    ["--force-delete-path"], ["--force-delete-path", ""],
    ["--force-delete-path", "E:\\one", "--force-delete-path", "E:\\two"],
    ["--force-delete-path", "--inspect"], ["--force-delete-path", "E:\\"],
    ["--force-delete-path", "E:\\*.txt"], ["--force-delete-path", "relative.txt"],
    ["--force-delete-path", "E:\\file.txt:stream"]
  ].map((argv) => [argv]))("rejects ambiguous or non-target arguments: %j", (argv) => {
    expect(() => parseForceDeleteLaunch(argv)).toThrow();
  });
  it("retains cold-start requests until the renderer is ready and deduplicates warm launches", () => {
    const queue = new ForceDeleteLaunchQueue();
    queue.enqueue("E:\\First"); queue.enqueue("e:\\first"); queue.enqueue("E:\\Second");
    expect(queue.pending).toBe(true);
    expect(queue.takeAll()).toEqual(["E:\\First", "E:\\Second"]);
    expect(queue.pending).toBe(false);
    expect(queue.takeAll()).toEqual([]);
    queue.enqueue("E:\\Later");
    expect(queue.takeAll()).toEqual(["E:\\Later"]);
  });
  it("reports queue overflow without discarding existing requests", () => {
    const queue = new ForceDeleteLaunchQueue();
    for (let index = 0; index < 20; index++) queue.enqueue(`E:\\${index}`);
    expect(() => queue.enqueue("E:\\overflow")).toThrow("过多");
    expect(queue.takeAll()).toHaveLength(20);
  });
});
