import type {
  ContentSearchOptions, SearchCategory, SearchFilters, SearchPageOptions,
  SearchSortDirection, SearchSortField
} from "./types";

const categories = new Set<SearchCategory>([
  "folder", "document", "image", "video", "audio", "archive", "executable", "code", "other"
]);
const sortFields = new Set<SearchSortField>(["relevance", "name", "path", "size", "modified", "type"]);
const sortDirections = new Set<SearchSortDirection>(["asc", "desc"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown, maxLength: number, limit: number): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length <= maxLength).slice(0, limit)
    : undefined;
}

function keywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 1024)).filter(Boolean);
  return [...new Set(items)].slice(0, 32);
}

function size(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function date(value: unknown, millis: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof millis !== "number" || !Number.isFinite(millis) || Math.abs(millis) > 8.64e15) return undefined;
  return new Date(millis).toISOString();
}

export function readContentOptions(value: unknown): ContentSearchOptions {
  const raw = object(value);
  return {
    keywords: keywords(raw.keywords),
    keywordMatch: "any",
    regex: raw.regex === true,
    caseSensitive: raw.caseSensitive === true,
    sortBy: sortFields.has(raw.sortBy as SearchSortField) ? raw.sortBy as SearchSortField : "relevance",
    sortDirection: sortDirections.has(raw.sortDirection as SearchSortDirection) ? raw.sortDirection as SearchSortDirection : "desc",
    minSize: size(raw.minSize),
    maxSize: size(raw.maxSize),
    modifiedAfter: date(raw.modifiedAfter, raw.modifiedAfterMs),
    modifiedBefore: date(raw.modifiedBefore, raw.modifiedBeforeMs)
  };
}

export function readSearchFilters(value: unknown): SearchFilters {
  const raw = object(value);
  const common = readContentOptions(raw);
  const fuzzy = !common.regex && raw.fuzzy === true;
  return {
    ...common,
    kind: raw.kind === "folder" || raw.kind === "file" ? raw.kind : "all",
    scope: typeof raw.scope === "string" && raw.scope && raw.scope.length <= 32_768 ? raw.scope : "*",
    scopes: strings(raw.scopes, 32_768, 32),
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((item): item is SearchCategory => categories.has(item)).slice(0, categories.size)
      : undefined,
    extensions: Array.isArray(raw.extensions)
      ? raw.extensions.filter((item): item is string => typeof item === "string" && /^[a-z0-9_+-]{1,24}$/i.test(item)).slice(0, 64)
      : undefined,
    wholeWord: !common.regex && !fuzzy && raw.wholeWord === true,
    fuzzy,
    matchPath: raw.matchPath === true
  };
}

export function readSearchPage(value: unknown, maxLimit: number): SearchPageOptions {
  const raw = object(value);
  return {
    cursor: typeof raw.cursor === "string" && raw.cursor.length <= 256 ? raw.cursor : undefined,
    limit: typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? Math.min(maxLimit, Math.max(1, Math.trunc(raw.limit)))
      : undefined
  };
}
