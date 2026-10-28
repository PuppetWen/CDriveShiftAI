import { describe, expect, it } from "vitest";
import { selectionRange, toggleResultSelection } from "../src/lib/result-selection";

describe("virtual search selection", () => {
  it("selects intersected rows across an unmounted virtual window in either direction", () => {
    expect(selectionRange(58 * 2 + 10, 58 * 60 + 20, 58, 240)).toEqual({ start: 2, end: 61 });
    expect(selectionRange(58 * 60 + 20, 58 * 2 + 10, 58, 240)).toEqual({ start: 2, end: 61 });
  });

  it("respects exact row boundaries and the taller content rows", () => {
    expect(selectionRange(82, 246, 82, 80)).toEqual({ start: 1, end: 3 });
    expect(selectionRange(82, 247, 82, 80)).toEqual({ start: 1, end: 4 });
  });

  it("clamps drags to available results rather than selecting unloaded rows", () => {
    expect(selectionRange(-100, 58 * 300, 58, 240)).toEqual({ start: 0, end: 240 });
    expect(selectionRange(58 * 245, 58 * 300, 58, 240)).toEqual({ start: 240, end: 240 });
    expect(selectionRange(0, 50, 58, 0)).toEqual({ start: 0, end: 0 });
  });

  it("Ctrl-click adds and removes one result without mutating prior selection", () => {
    const initial = new Set(["E:\\one.txt", "E:\\two.txt"]);
    expect([...toggleResultSelection(initial, "E:\\three.txt")]).toEqual(["E:\\one.txt", "E:\\two.txt", "E:\\three.txt"]);
    expect([...toggleResultSelection(initial, "E:\\one.txt")]).toEqual(["E:\\two.txt"]);
    expect([...initial]).toEqual(["E:\\one.txt", "E:\\two.txt"]);
  });
});
