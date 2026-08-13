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
    expect(normalizeMouseHoldMs(-1)).toBe(0);
    expect(normalizeMouseHoldMs(49)).toBe(0);
    expect(normalizeMouseHoldMs(51)).toBe(100);
    expect(normalizeMouseHoldMs(1_249)).toBe(1_200);
    expect(normalizeMouseHoldMs(1_251)).toBe(1_300);
    expect(normalizeMouseHoldMs(12_000)).toBe(3_000);
  });

  it("calculates a bounded progress fill", () => {
    expect(mouseHoldProgress(0)).toBe(0);
    expect(mouseHoldProgress(1_500)).toBe(50);
    expect(mouseHoldProgress(3_000)).toBe(100);
  });
});
