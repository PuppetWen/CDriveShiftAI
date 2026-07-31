import type {
  SearchBookmark,
  SearchCategory,
  SearchFilters,
  SearchResult
} from "../types";

export type SearchMode = "name" | "content";
export type DatePreset = "any" | "today" | "week" | "month" | "year" | "custom";

const categoryExtensions: Partial<Record<SearchCategory, readonly string[]>> = {
  document: [
    "doc", "docx", "odt", "pdf", "ppt", "pptx", "rtf", "txt", "csv", "xls", "xlsx"
  ],
  image: ["avif", "bmp", "gif", "heic", "ico", "jpeg", "jpg", "png", "svg", "webp"],
  video: ["avi", "flv", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"],
  audio: ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"],
  archive: ["7z", "bz2", "cab", "gz", "iso", "rar", "tar", "xz", "zip", "zst"],
  executable: ["appx", "bat", "cmd", "com", "dll", "exe", "msi", "msix", "ps1", "scr"],
  code: [
    "c", "cpp", "cs", "css", "go", "h", "html", "java", "js", "jsx", "json", "kt",
    "lua", "md", "php", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml", "ts",
    "tsx", "vue", "xml", "yaml", "yml"
  ]
};

export const regexTemplates = [
  {
    name: "IPv4 地址",
    pattern: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`,
    description: "查找日志、配置里的 IPv4 地址"
  },
  {
    name: "邮箱地址",
    pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    description: "查找常见电子邮箱格式"
  },
  {
    name: "日期",
    pattern: String.raw`\b\d{4}[-/]\d{2}[-/]\d{2}\b`,
    description: "匹配 2026-07-28 或 2026/07/28"
  },
  {
    name: "HTTP 错误码",
    pattern: String.raw`\b[45]\d{2}\b`,
    description: "查找 4xx 与 5xx 状态码"
  },
  {
    name: "密钥线索",
    pattern: String.raw`(?:api[_-]?key|token|secret)\s*[:=]\s*\S+`,
    description: "查找常见 Key、Token、Secret 赋值"
  }
] as const;

export const regexTokens = [
  { label: "任意内容", value: ".*", hint: "任意数量字符" },
  { label: "数字", value: String.raw`\d+`, hint: "一个或多个数字" },
  { label: "空白", value: String.raw`\s+`, hint: "一个或多个空白" },
  { label: "单词边界", value: String.raw`\b`, hint: "限定完整单词" },
  { label: "二选一", value: "(?:A|B)", hint: "匹配 A 或 B" },
  { label: "英文字母", value: "[A-Za-z]+", hint: "一个或多个字母" }
] as const;

export function defaultFilters(): SearchFilters {
  return {
    kind: "all",
    scope: "*",
    scopes: [],
    categories: [],
    extensions: [],
    caseSensitive: false,
    wholeWord: false,
    matchPath: false,
    regex: false,
    sortBy: "relevance",
    sortDirection: "desc"
  };
}

export function normalizeScopePath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLocaleLowerCase();
}

export function categoryOf(result: SearchResult): SearchCategory {
  if (result.isDirectory) return "folder";
  const name = result.name.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : "";
  return (
    Object.entries(categoryExtensions).find(([, extensions]) =>
      extensions?.includes(extension)
    )?.[0] as SearchCategory | undefined
  ) ?? "other";
}

export function deriveKind(categories: SearchCategory[]): SearchFilters["kind"] {
  if (categories.length === 1 && categories[0] === "folder") return "folder";
  if (categories.length > 0 && !categories.includes("folder")) return "file";
  return "all";
}

export function startOfPreset(preset: DatePreset): string | undefined {
  if (preset === "any" || preset === "custom") return undefined;
  const value = new Date();
  if (preset === "today") value.setHours(0, 0, 0, 0);
  if (preset === "week") value.setDate(value.getDate() - 7);
  if (preset === "month") value.setMonth(value.getMonth() - 1);
  if (preset === "year") value.setFullYear(value.getFullYear() - 1);
  return value.toISOString();
}

export function bookmarkSignature(value: {
  mode: SearchMode;
  query: string;
  filters: SearchFilters;
  filterPanelOpen: boolean;
  extensionInput: string;
  datePreset: DatePreset;
  contentScope: string;
}): string {
  return JSON.stringify({
    mode: value.mode,
    query: value.query.trim(),
    filters: value.filters,
    filterPanelOpen: value.filterPanelOpen,
    extensionInput: value.extensionInput,
    datePreset: value.datePreset,
    contentScope: value.contentScope
  });
}

export function bookmarkConditionCount(bookmark: SearchBookmark): number {
  const filters = bookmark.filters;
  return (
    (filters.categories?.length ?? 0) +
    (filters.scopes?.length ?? 0) +
    (filters.extensions?.length ?? 0) +
    Number(filters.minSize != null || filters.maxSize != null) +
    Number(filters.modifiedAfter != null || filters.modifiedBefore != null) +
    Number(filters.caseSensitive) +
    Number(filters.wholeWord) +
    Number(filters.matchPath) +
    Number(filters.regex) +
    Number(bookmark.mode === "content" && bookmark.contentScope !== "*")
  );
}

export function validateRegexPattern(pattern: string): { valid: boolean; message: string } {
  if (!pattern.trim()) {
    return { valid: false, message: "输入表达式后，这里会实时检查格式。" };
  }
  if (pattern.length > 1024) {
    return { valid: false, message: "表达式不能超过 1024 个字符。" };
  }
  if (/\(\?(?:=|!|<=|<!)/.test(pattern)) {
    return {
      valid: false,
      message: "为保证大文件搜索稳定，暂不支持前后查找（lookaround）。"
    };
  }
  if (/\\[1-9]/.test(pattern)) {
    return {
      valid: false,
      message: "为保证线性时间搜索，暂不支持 \\1 这类反向引用。"
    };
  }
  try {
    const expression = new RegExp(pattern, "u");
    if (expression.test("")) {
      return {
        valid: false,
        message: "该表达式能匹配空内容，请增加一个明确字符或条件。"
      };
    }
    return {
      valid: true,
      message: "表达式有效。正文搜索会扫描本地索引，不会重新读取原文件。"
    };
  } catch (reason) {
    const raw = reason instanceof Error ? reason.message : String(reason);
    return {
      valid: false,
      message: raw.replace(/^Invalid regular expression:\s*/i, "格式错误：")
    };
  }
}
