import { describe, expect, it } from "vitest";
import { portableCandidateScores } from "../electron/analyzer";
import { inferKnownDirectory } from "../electron/directory-knowledge";
import { hasSignificantAnalysisChange } from "../electron/analysis-freshness";

describe("directory ownership evidence", () => {
  it("uses portable executables from another drive as first-party ownership evidence", () => {
    const candidates = portableCandidateScores(
      "C:\\Users\\tester\\AppData\\Roaming\\RedScope AI",
      [
        "E:\\PortableApps\\RedScope AI\\redscope.exe",
        "F:\\Tools\\Unrelated\\helper.exe"
      ]
    );

    expect(candidates[0]?.appName).toBe("RedScope AI");
    expect(candidates[0]?.confidence).toBeGreaterThan(0.6);
    expect(candidates[0]?.evidence.join("\n")).toContain(
      "E:\\PortableApps\\RedScope AI\\redscope.exe"
    );
  });

  it("does not invent a portable application match without name or path evidence", () => {
    const candidates = portableCandidateScores(
      "C:\\Users\\tester\\AppData\\Roaming\\UnknownVendorData",
      ["E:\\PortableApps\\RedScope AI\\redscope.exe"]
    );

    expect(candidates).toEqual([]);
  });

  it("treats a standard directory signature as evidence rather than an unknown folder", () => {
    const insight = inferKnownDirectory("C:\\Users\\tester\\.codex");

    expect(insight?.producedBy).toBe("OpenAI Codex");
    expect(insight?.confidence).toBeGreaterThanOrEqual(0.99);
    expect(insight?.risk).toBe("high");
    expect(insight?.purpose).toContain("Codex");
  });

  it("recommends reanalysis only after a material directory change", () => {
    const snapshot = {
      analyzedAt: new Date().toISOString(),
      totalBytes: 1024 ** 3,
      fileCount: 10_000,
      directoryCount: 1_000
    };
    expect(
      hasSignificantAnalysisChange(snapshot, {
        totalBytes: snapshot.totalBytes + 8 * 1024 ** 2,
        fileCount: 10_020,
        directoryCount: 1_005
      })
    ).toBe(false);
    expect(
      hasSignificantAnalysisChange(snapshot, {
        totalBytes: snapshot.totalBytes + 300 * 1024 ** 2,
        fileCount: 12_000,
        directoryCount: 1_300
      })
    ).toBe(true);
  });
});
