import { describe, expect, it } from "vitest";
import {
  mouseHoldProgress,
  mouseShortcutButtonFromEventCode,
  normalizeMouseHoldMs
} from "../src/lib/mouseShortcut";

describe("mouse shortcut controls", () => {
  it("maps Chromium mouse event codes to supported global buttons", () => {
    expect(mouseShortcutButtonFromEventCode(1)).toBe("middle");
    expect(mouseShortcutButtonFromEventCode(3)).toBe("back");
    expect(mouseShortcutButtonFromEventCode(4)).toBe("forward");
    expect(mouseShortcutButtonFromEventCode(0)).toBeUndefined();
    expect(mouseShortcutButtonFromEventCode(2)).toBeUndefined();
  });

  it("clamps and rounds the hold slider to 100 millisecond steps", () => {
    expect(normalizeMouseHoldMs(349)).toBe(500);
    expect(normalizeMouseHoldMs(1_249)).toBe(1_200);
    expect(normalizeMouseHoldMs(1_251)).toBe(1_300);
    expect(normalizeMouseHoldMs(12_000)).toBe(10_000);
  });

  it("calculates a bounded progress fill", () => {
    expect(mouseHoldProgress(500)).toBe(0);
    expect(mouseHoldProgress(10_000)).toBe(100);
    expect(mouseHoldProgress(5_250)).toBeGreaterThan(50);
    expect(mouseHoldProgress(5_250)).toBeLessThan(51);
  });
});
