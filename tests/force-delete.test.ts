import { describe, expect, it } from "vitest";
import {
  commandLineReferencesTarget,
  matchProcessesForTarget
} from "../electron/force-delete";

describe("controlled force deletion", () => {
  it("matches executables launched from the selected directory", () => {
    const matches = matchProcessesForTarget(
      [{
        pid: 4100,
        name: "tool.exe",
        executablePath: "E:\\Tools\\Example\\bin\\tool.exe",
        commandLine: "\"E:\\Tools\\Example\\bin\\tool.exe\" --serve"
      }],
      "E:\\Tools\\Example",
      true
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ pid: 4100, matchReason: "executable", canTerminate: true });
  });

  it("does not match sibling paths that merely share a prefix", () => {
    expect(
      commandLineReferencesTarget(
        "\"E:\\Tools\\Example-Backup\\tool.exe\"",
        "E:\\Tools\\Example"
      )
    ).toBe(false);
  });

  it("matches quoted and option-assigned target paths", () => {
    expect(
      commandLineReferencesTarget(
        "worker.exe --data=\"E:\\App Data\\Target\" --quiet",
        "E:\\App Data\\Target"
      )
    ).toBe(true);
  });

  it("never marks protected Windows processes as terminable", () => {
    const matches = matchProcessesForTarget(
      [{
        pid: 812,
        name: "explorer.exe",
        executablePath: "C:\\Windows\\explorer.exe",
        commandLine: "explorer.exe \"E:\\Target\""
      }],
      "E:\\Target",
      true
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.canTerminate).toBe(false);
  });
});
