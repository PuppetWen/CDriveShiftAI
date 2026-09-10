import { describe, expect, it } from "vitest";
import {
  isPathWithin,
  isHighRiskApplicationPath,
  normalizeWindowsPath,
  protectedReason,
  samePath
} from "../electron/system";

describe("Windows path safety", () => {
  it("normalizes path comparisons without case sensitivity", () => {
    expect(samePath("c:\\Users\\Alice\\Data\\", "C:\\users\\alice\\data")).toBe(true);
  });

  it("detects containment without accepting sibling prefixes", () => {
    expect(isPathWithin("C:\\Users\\Alice\\Data", "C:\\Users\\Alice")).toBe(true);
    expect(isPathWithin("C:\\Users\\Alice2", "C:\\Users\\Alice")).toBe(false);
    expect(isPathWithin("C:\\Users\\Alice\\..cache", "C:\\Users\\Alice")).toBe(true);
  });

  it("blocks drive roots and protected system paths", () => {
    expect(protectedReason("C:\\")).toContain("盘符根目录");
    expect(protectedReason("D:\\")).toContain("盘符根目录");
    expect(protectedReason("C:\\Windows\\Temp")).toContain("受保护");
    expect(protectedReason("C:\\Users")).toContain("受保护");
    expect(protectedReason("C:\\Program Files\\WindowsApps\\Package")).toContain("受保护");
    expect(protectedReason("D:\\WindowsApps\\Package")).toContain("系统管理");
    expect(protectedReason("\\\\?\\C:\\Windows")).toContain("命名空间");
  });

  it("allows an ordinary user application data directory", () => {
    expect(protectedReason("C:\\Users\\Alice\\AppData\\Local\\ExampleApp")).toBeUndefined();
    expect(normalizeWindowsPath("C:/Users/Alice/AppData/Local/ExampleApp/")).toBe(
      "C:\\Users\\Alice\\AppData\\Local\\ExampleApp"
    );
  });

  it("allows ordinary directories on any drive and marks app installs as high risk", () => {
    expect(protectedReason("D:\\Games\\Example\\Data")).toBeUndefined();
    expect(protectedReason("C:\\Program Files\\ExampleApp")).toBeUndefined();
    expect(isHighRiskApplicationPath("C:\\Program Files\\ExampleApp")).toBe(true);
  });
});
