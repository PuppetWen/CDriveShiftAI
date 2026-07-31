import { describe, expect, it } from "vitest";
import {
  determineIndexRefreshReason,
  INDEX_REFRESH_INTERVAL_MS
} from "../electron/index-refresh-policy";

const hour = 60 * 60 * 1_000;
const now = Date.UTC(2026, 6, 29, 12, 0, 0);

describe("index refresh policy", () => {
  it("reuses a fresh index created during the current Windows boot", () => {
    expect(determineIndexRefreshReason(now - hour, now, 2 * 60 * 60)).toBeUndefined();
  });

  it("rebuilds once when the cache predates the current Windows boot", () => {
    expect(determineIndexRefreshReason(now - 3 * hour, now, 2 * 60 * 60)).toBe(
      "system-restart"
    );
  });

  it("rebuilds an index after 24 hours", () => {
    expect(
      determineIndexRefreshReason(
        now - INDEX_REFRESH_INTERVAL_MS,
        now,
        7 * 24 * 60 * 60
      )
    ).toBe("daily");
  });

  it("does not force a rebuild for missing or invalid metadata", () => {
    expect(determineIndexRefreshReason(0, now, 120)).toBeUndefined();
    expect(determineIndexRefreshReason(Number.NaN, now, 120)).toBeUndefined();
  });
});
