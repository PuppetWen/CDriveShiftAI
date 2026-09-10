import { describe, expect, it } from "vitest";
import { ForceDeleteLaunchQueue, parseForceDeleteLaunch } from "../electron/force-delete-launch";

describe("Explorer deletion request routing", () => {
  it("accepts a quoted argument as literal data including Unicode and shell punctuation", () => {
    const target = "E:\\资料 $(whoami) & work\\[draft];x.txt";
    expect(parseForceDeleteLaunch(["app.exe", "--force-delete-path", target])).toBe(target);
  });
  it("ignores ordinary launches", () => {
    expect(parseForceDeleteLaunch(["app.exe", "--startup-minimized"])).toBeUndefined();
  });
  it.each([
    ["--force-delete-path"], ["--force-delete-path", ""],
    ["--force-delete-path", "E:\\one", "--force-delete-path", "E:\\two"],
    ["--force-delete-path", "--inspect"], ["--force-delete-path", "E:\\"],
    ["--force-delete-path", "E:\\*.txt"], ["--force-delete-path", "relative.txt"],
    ["--force-delete-path", "E:\\file.txt:stream"]
  ])("rejects ambiguous or non-target arguments: %j", (argv) => {
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
