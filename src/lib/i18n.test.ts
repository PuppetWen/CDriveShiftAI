import { describe, expect, it } from "vitest";
import {
  languageOptions,
  localizeRuntimeText,
  resolvedLanguage,
  translate
} from "./i18n";
import { bundledReleaseNotesEnglish } from "./releaseNotes";

describe("application localization", () => {
  it("offers at least ten explicit mainstream languages", () => {
    const explicitLanguages = languageOptions.filter((option) => option.id !== "system");
    expect(explicitLanguages.length).toBeGreaterThanOrEqual(10);
    expect(new Set(explicitLanguages.map((option) => option.id)).size).toBe(explicitLanguages.length);
  });

  it("provides a usable navigation label for every selectable language", () => {
    for (const option of languageOptions) {
      expect(translate("nav.settings", undefined, option.id).trim()).not.toBe("");
      expect(resolvedLanguage(option.id)).not.toBe("system");
    }
  });

  it("substitutes values after selecting a locale", () => {
    expect(translate("sidebar.entries", { count: 42 }, "zh-CN")).toContain("42");
    expect(translate("sidebar.entries", { count: 42 }, "de-DE")).toContain("42");
  });

  it("localizes persisted index and ownership result messages", () => {
    expect(
      localizeRuntimeText(
        "已载入持久化索引并重放 1901 条增量，实时监听已接管",
        "en-US"
      )
    ).toBe(
      "Persistent index loaded; replayed 1901 changes and activated live monitoring"
    );
    expect(
      localizeRuntimeText(
        "面向全体用户的共享应用配置、服务状态、缓存与数据库",
        "en-US"
      )
    ).not.toMatch(/[\u3400-\u9fff]/u);
    expect(localizeRuntimeText("Windows 应用安装体系", "en-US")).toBe(
      "Windows application installation system"
    );
  });

  it("bundles non-Chinese release notes for the current version", () => {
    const releaseText = [
      bundledReleaseNotesEnglish.summary,
      ...bundledReleaseNotesEnglish.sections.flatMap((section) => [
        section.title,
        ...section.items
      ])
    ].join(" ");
    expect(releaseText).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
