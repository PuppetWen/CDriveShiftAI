import { describe, expect, it } from "vitest";
import {
  normalizeUiScale,
  uiScaleFromLockedDrag,
  uiScaleProgress
} from "../src/lib/uiScale";

describe("continuous interface scale", () => {
  it("uses standard size as 100% and clamps between 50% and 300%", () => {
    expect(normalizeUiScale(0.2)).toBe(0.5);
    expect(normalizeUiScale(1)).toBe(1);
    expect(normalizeUiScale(4)).toBe(3);
  });

  it("rounds values to ten-percent slider steps", () => {
    expect(normalizeUiScale(1.04)).toBe(1);
    expect(normalizeUiScale(1.06)).toBe(1.1);
    expect(normalizeUiScale(2.74)).toBe(2.7);
  });

  it("calculates the slider fill across the entire scale range", () => {
    expect(uiScaleProgress(0.5)).toBe(0);
    expect(uiScaleProgress(1.8)).toBe(52);
    expect(uiScaleProgress(3)).toBe(100);
  });

  it("keeps drag values tied to the track width captured before live zoom", () => {
    expect(uiScaleFromLockedDrag(1, 40, 500)).toBe(1.2);
    expect(uiScaleFromLockedDrag(1, 80, 500)).toBe(1.4);
    expect(uiScaleFromLockedDrag(1, -80, 500)).toBe(0.6);
    expect(uiScaleFromLockedDrag(1, 80, 0)).toBe(1);
  });
});
