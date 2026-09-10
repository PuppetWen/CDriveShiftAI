import { describe, expect, it } from "vitest";
import { migrationDestinationFor, normalizeMigrationPath } from "../../electron/migration-path";

describe("migrationDestinationFor", () => {
  it("places a migrated directory directly below the selected destination", () => {
    expect(
      migrationDestinationFor(
        "C:\\Users\\puppet\\AppData\\Local\\D3DSCache",
        "E:\\DevelopmentTools\\AIDevelop\\CDriveShiftAI\\release-ready"
      )
    ).toBe(
      "E:\\DevelopmentTools\\AIDevelop\\CDriveShiftAI\\release-ready\\D3DSCache"
    );
  });

  it("does not mirror the source drive and parent hierarchy", () => {
    const result = migrationDestinationFor(
      "C:\\Users\\puppet\\AppData\\Local\\D3DSCache\\",
      "E:\\Archive\\"
    );

    expect(result).toBe("E:\\Archive\\D3DSCache");
    expect(result).not.toContain("\\C\\Users\\");
    expect(result).not.toContain("\\CDriveShiftAI\\C\\");
  });

  it("rejects relative, drive-relative, root, and alternate-stream source paths", () => {
    for (const source of ["", "app", "C:app", "C:\\", "C:\\Apps\\App:stream", "C:\\Apps\\bad."]) {
      expect(() => migrationDestinationFor(source, "D:\\Moved")).toThrow();
    }
    expect(() => normalizeMigrationPath("\\\\server\\share\\App")).toThrow();
  });
});
