import { describe, expect, it } from "vitest";
import { calculateVirtualListRange } from "../src/lib/virtual-list";

describe("virtual list range", () => {
  it("renders only the visible window plus overscan", () => {
    expect(calculateVirtualListRange(10_000, 50, 5_000, 500, 4)).toEqual({
      start: 96,
      end: 114,
      paddingTop: 4_800,
      paddingBottom: 494_300
    });
  });

  it("clamps the final window without changing total height", () => {
    const range = calculateVirtualListRange(1_000, 40, 39_800, 400, 6);
    expect(range.end).toBe(1_000);
    expect(range.paddingTop + (range.end - range.start) * 40 + range.paddingBottom).toBe(
      40_000
    );
  });
});
