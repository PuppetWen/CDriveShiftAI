import { describe, expect, it } from "vitest";
import type { MigrationRecord } from "../types";
import { canDeleteMigrationRecord } from "./migration-record";

const record: MigrationRecord = {
  id: "test", source: "C:\\App", destination: "D:\\App", stage: "linked",
  totalBytes: 1, copiedBytes: 1, migrationCount: 1,
  startedAt: "2026-09-08", updatedAt: "2026-09-08", warnings: []
};

describe("migration history deletion eligibility", () => {
  it("preserves the recovery record for a live junction", () => {
    expect(canDeleteMigrationRecord(record)).toBe(false);
  });

  it.each(["preflight", "copying", "verifying", "switching", "rolling-back"] as const)(
    "protects a transaction at %s", (stage) => {
      expect(canDeleteMigrationRecord({ ...record, stage })).toBe(false);
    }
  );

  it.each(["stagingPath", "backupPath", "restorePath"] as const)(
    "keeps a failed migration that still references %s", (field) => {
      expect(canDeleteMigrationRecord({ ...record, stage: "failed", [field]: "D:\\recovery" })).toBe(false);
    }
  );

  it("allows deleting completed restoration and failures with no recovery paths", () => {
    expect(canDeleteMigrationRecord({ ...record, stage: "rolled-back" })).toBe(true);
    expect(canDeleteMigrationRecord({ ...record, stage: "failed" })).toBe(true);
  });
});
