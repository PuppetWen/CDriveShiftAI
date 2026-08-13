import { describe, expect, it } from "vitest";
import {
  bundledReleaseHistory,
  bundledReleaseHistoryEnglish
} from "../src/lib/releaseHistory";
import { bundledReleaseNotes } from "../src/lib/releaseNotes";

describe("bundled release history", () => {
  it("includes every published version from the current release to 0.0.1", () => {
    const versions = bundledReleaseHistory.map((release) => release.version);
    expect(versions[0]).toBe(bundledReleaseNotes.version);
    expect(versions).toContain("0.0.11");
    expect(versions).toContain("0.0.1");
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("keeps localized histories structurally aligned and expandable", () => {
    expect(bundledReleaseHistoryEnglish.map((release) => release.version)).toEqual(
      bundledReleaseHistory.map((release) => release.version)
    );
    for (const release of bundledReleaseHistoryEnglish) {
      expect(release.summary.length).toBeGreaterThan(0);
      expect(release.sections.length).toBeGreaterThan(0);
      expect(release.sections.every((section) => section.items.length > 0)).toBe(true);
    }
  });
});
