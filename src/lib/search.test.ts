import { describe, expect, it } from "vitest";
import {
  bookmarkConditionCount,
  categoryOf,
  defaultFilters,
  deriveKind,
  normalizeScopePath,
  validateRegexPattern
} from "./search";
import type { SearchBookmark, SearchResult } from "../types";

function result(name: string, isDirectory = false): SearchResult {
  return {
    name,
    path: `E:\\test\\${name}`,
    isDirectory,
    size: 10,
    modifiedAt: new Date(0).toISOString(),
    score: 1,
    source: "native-index"
  };
}

describe("search helpers", () => {
  it("normalizes extended and slash-separated scopes", () => {
    expect(normalizeScopePath("\\\\?\\E:/Data/")).toBe("e:\\data");
  });

  it("derives backend kinds from combined categories", () => {
    expect(deriveKind(["folder"])).toBe("folder");
    expect(deriveKind(["document", "image"])).toBe("file");
    expect(deriveKind(["folder", "image"])).toBe("all");
  });

  it("classifies common file extensions without UI dependencies", () => {
    expect(categoryOf(result("photo.PNG"))).toBe("image");
    expect(categoryOf(result("main.tsx"))).toBe("code");
    expect(categoryOf(result("workspace", true))).toBe("folder");
    expect(categoryOf(result("README"))).toBe("other");
  });

  it("rejects unstable or empty regular expressions", () => {
    expect(validateRegexPattern("error\\s+[45]\\d{2}").valid).toBe(true);
    expect(validateRegexPattern(".*").valid).toBe(false);
    expect(validateRegexPattern("(a)\\1").valid).toBe(false);
    expect(validateRegexPattern("(?=secret)").valid).toBe(false);
  });

  it("counts persisted bookmark conditions", () => {
    const bookmark = {
      id: "bookmark",
      name: "report",
      query: "report",
      mode: "name",
      contentScope: "*",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      filterPanelOpen: true,
      extensionInput: "pdf",
      datePreset: "any",
      filters: {
        ...defaultFilters(),
        categories: ["document"],
        extensions: ["pdf"],
        caseSensitive: true,
        minSize: 1024
      }
    } satisfies SearchBookmark;
    expect(bookmarkConditionCount(bookmark)).toBe(4);
  });
});
