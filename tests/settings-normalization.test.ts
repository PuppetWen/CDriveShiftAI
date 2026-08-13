import { describe, expect, it } from "vitest";
import {
  normalizeStoredMouseHoldMs,
  normalizeStoredUiScale
} from "../electron/settings-normalization";

describe("persisted setting normalization", () => {
  it("keeps legacy scale presets and accepts the new continuous range", () => {
    expect(normalizeStoredUiScale(0.9)).toBe(0.9);
    expect(normalizeStoredUiScale(1.2)).toBe(1.2);
    expect(normalizeStoredUiScale(2.74)).toBe(2.7);
    expect(normalizeStoredUiScale(9)).toBe(3);
    expect(normalizeStoredUiScale("large")).toBe(1);
  });

  it("allows instant mouse activation and clamps legacy long values", () => {
    expect(normalizeStoredMouseHoldMs(0)).toBe(0);
    expect(normalizeStoredMouseHoldMs(49)).toBe(0);
    expect(normalizeStoredMouseHoldMs(51)).toBe(100);
    expect(normalizeStoredMouseHoldMs(10_000)).toBe(3_000);
  });
});
