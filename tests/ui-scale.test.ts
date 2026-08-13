import { describe, expect, it } from "vitest";
import { normalizeUiScale, uiScaleProgress } from "../src/lib/uiScale";

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
});
