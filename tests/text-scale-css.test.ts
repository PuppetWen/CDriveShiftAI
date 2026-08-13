import { describe, expect, it } from "vitest";
import { transformTextScaleCss } from "../scripts/text-scale-css";

describe("text-only CSS scaling", () => {
  it("scales every font declaration without scaling box geometry", () => {
    const output = transformTextScaleCss(`
      .result { width: 320px; height: 82px; font-size: 12px; line-height: 18px; }
      .title { font: 700 16px/1.2 sans-serif; }
      .hero { font-size: clamp(28px, 2.8vw, 40px); }
    `);
    expect(output).toContain("width: 320px");
    expect(output).toContain("height: 82px");
    expect(output).toContain("font-size: calc(12px * var(--text-scale, 1))");
    expect(output).toContain("line-height: calc(18px * var(--text-scale, 1))");
    expect(output).toContain("font: 700 calc(16px * var(--text-scale, 1))/1.2");
    expect(output).toContain("calc(2.8vw * var(--text-scale, 1))");
  });
});
