import type { MigrationRecord } from "../types";

export function canDeleteMigrationRecord(record: MigrationRecord): boolean {
  return ["rolled-back", "failed"].includes(record.stage) &&
    !record.stagingPath && !record.backupPath && !record.restorePath;
}
