import { describe, expect, it } from "vitest";
import { migrationDestinationFor } from "../../electron/migration-path";

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
});
