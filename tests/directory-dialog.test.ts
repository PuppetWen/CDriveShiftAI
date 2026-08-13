import { describe, expect, it } from "vitest";
import {
  normalizeDirectoryDialogPurpose,
  sanitizeDirectoryDialogPaths
} from "../electron/directory-dialog";

describe("directory dialog history", () => {
  it("keeps valid remembered directories separated by purpose", () => {
    expect(
      sanitizeDirectoryDialogPaths({
        "migration-source": " C:\\Users\\tester\\.codex ",
        "migration-destination": "D:\\Data",
        unknown: "E:\\ignored",
        analysis: 42
      })
    ).toEqual({
      "migration-source": "C:\\Users\\tester\\.codex",
      "migration-destination": "D:\\Data"
    });
  });

  it("falls back to general for an invalid caller purpose", () => {
    expect(normalizeDirectoryDialogPurpose("migration-source")).toBe("migration-source");
    expect(normalizeDirectoryDialogPurpose("unexpected")).toBe("general");
    expect(normalizeDirectoryDialogPurpose(undefined)).toBe("general");
  });
});
