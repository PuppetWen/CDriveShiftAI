import { describe, expect, it } from "vitest";
import { assertReleaseVersion, nextReleaseVersion, validateVersionMetadata } from "../scripts/version-policy.mjs";

const notes = (zh: string, en = zh) => `
export const bundledReleaseNotes: BundledReleaseNote = { "version": "${zh}" };
export const bundledReleaseNotesEnglish: BundledReleaseNote = { "version": "${en}" };
`;

describe("current release version policy", () => {
  it("increments one release at a time and carries instead of producing two-digit components", () => {
    expect(nextReleaseVersion("0.2.0")).toBe("0.2.1");
    expect(nextReleaseVersion("0.1.9")).toBe("0.2.0");
    expect(nextReleaseVersion("0.2.9")).toBe("0.3.0");
    expect(nextReleaseVersion("0.9.9")).toBe("1.0.0");
    expect(nextReleaseVersion("9.9.8")).toBe("9.9.9");
    expect(() => nextReleaseVersion("9.9.9")).toThrow("exhausts");
  });

  it("rejects multi-digit components, malformed values and suffixes", () => {
    for (const version of ["0.1.12", "0.10.0", "10.0.0", "00.2.0", "v0.2.0", "0.2", "0.2.0.0", "0.2.0-beta", "0.2.0\n", "-1.2.0", undefined]) {
      expect(() => assertReleaseVersion(version)).toThrow("single digit");
    }
    expect(assertReleaseVersion("0.0.0")).toBe("0.0.0");
    expect(assertReleaseVersion("9.9.9")).toBe("9.9.9");
  });

  it("requires current package, lock root and bilingual notes to agree without constraining dependencies or history", () => {
    const pkg = { version: "0.2.0", dependencies: { example: "^12.34.56" } };
    const lock = { version: "0.2.0", packages: { "": { version: "0.2.0" }, "node_modules/example": { version: "12.34.56" } } };
    expect(validateVersionMetadata(pkg, lock, notes("0.2.0") + '\nconst history = [{ version: "0.1.12" }];')).toBe("0.2.0");
    expect(() => validateVersionMetadata(pkg, { ...lock, version: "0.1.12" }, notes("0.2.0"))).toThrow("root versions");
    expect(() => validateVersionMetadata(pkg, { ...lock, packages: { "": { version: "0.1.12" } } }, notes("0.2.0"))).toThrow("root versions");
    expect(() => validateVersionMetadata(pkg, lock, notes("0.1.12", "0.2.0"))).toThrow("bundledReleaseNotes");
    expect(() => validateVersionMetadata(pkg, lock, notes("0.2.0", "0.1.12"))).toThrow("bundledReleaseNotesEnglish");
    expect(() => validateVersionMetadata(pkg, lock, notes("0.2.0").replace('"version": "0.2.0"', '"summary": "Version missing"'))).toThrow("bundledReleaseNotes");
  });
});
