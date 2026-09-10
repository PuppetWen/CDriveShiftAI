import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  AudioLines,
  Bookmark,
  BookmarkPlus,
  Braces,
  ChevronDown,
  Database,
  File,
  FileCog,
  FileSearch,
  FileText,
  Film,
  Folder,
  FolderPlus,
  FolderOpen,
  FolderX,
  Globe2,
  Image,
  Info,
  ListFilter,
  Play,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  Zap
} from "lucide-react";
import { SearchContextMenu } from "../components/SearchContextMenu";
import { ForceDeleteDialog } from "../components/ForceDeleteDialog";
import { PathPropertiesDialog } from "../components/PathPropertiesDialog";
import { ThemedTooltip } from "../components/ThemedTooltip";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, EmptyState } from "../components/ui";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useVirtualList } from "../lib/virtual-list";
import {
  bookmarkConditionCount,
  bookmarkSignature,
  categoryOf,
  defaultFilters,
  deriveKind,
  normalizeScopePath,
  regexTemplates,
  regexTokens,
  startOfPreset,
  validateRegexPattern,
  type DatePreset,
  type SearchMode
} from "../lib/search";
import type {
  ContentIndexerStatus,
  ContentSearchResult,
  DirectorySizeResult,
  DriveInfo,
  IndexerStatus,
  SearchCategory,
  SearchBookmark,
  SearchBookmarkFolder,
  SearchFilters,
  SearchResult,
  SearchResultColumnWidths,
  SearchSortDirection,
  SearchSortField,
  SearchWorkspaceState
} from "../types";

interface SearchViewProps {
  indexer: IndexerStatus;
  drives: DriveInfo[];
  onAnalyze: (path: string) => void;
  onMigrate: (path: string) => void;
  notify: (type: "success" | "error", message: string) => void;
  standalone?: boolean;
  onRequestForceDelete?: (path: string, onDeleted: (path: string) => void) => void;
}

const NAME_PAGE_SIZE = 240;
const CONTENT_PAGE_SIZE = 80;
const SEARCH_COLUMN_KEYS = [
  "name",
  "path",
  "type",
  "size",
  "modified",
  "action"
] as const satisfies ReadonlyArray<keyof SearchResultColumnWidths>;
const DEFAULT_SEARCH_COLUMN_WIDTHS: SearchResultColumnWidths = {
  name: 22,
  path: 34,
  type: 9,
  size: 9,
  modified: 16,
  action: 10
};
const MIN_SEARCH_COLUMN_WIDTHS: SearchResultColumnWidths = {
  name: 12,
  path: 16,
  type: 6,
  size: 7,
  modified: 10,
  action: 7
};

const categoryDefinitions: Array<{
  value: SearchCategory;
  label: TranslationKey;
  icon: typeof Folder;
}> = [
  { value: "folder", label: "search.category.folder", icon: Folder },
  { value: "document", label: "search.category.document", icon: FileText },
  { value: "image", label: "search.category.image", icon: Image },
  { value: "video", label: "search.category.video", icon: Film },
  { value: "audio", label: "search.category.audio", icon: AudioLines },
  { value: "archive", label: "search.category.archive", icon: Archive },
  { value: "executable", label: "search.category.executable", icon: FileCog },
  { value: "code", label: "search.category.code", icon: Braces },
  { value: "other", label: "search.category.other", icon: File }
];

const categoryLabels = Object.fromEntries(
  categoryDefinitions.map((item) => [item.value, item.label])
) as Record<SearchCategory, TranslationKey>;

const sortLabels: Record<SearchSortField, TranslationKey> = {
  relevance: "search.sort.relevance",
  name: "search.sort.name",
  path: "search.sort.path",
  size: "search.sort.size",
  modified: "search.sort.modified",
  type: "search.sort.type"
};

type NameMatchMode = "contains" | "whole" | "fuzzy" | "regex";

const nameMatchModeLabels: Record<NameMatchMode, TranslationKey> = {
  contains: "search.match.contains",
  whole: "search.match.whole",
  fuzzy: "search.match.fuzzy",
  regex: "search.match.regex"
};

const nameMatchModeDetails: Record<NameMatchMode, TranslationKey> = {
  contains: "search.match.containsDetail",
  whole: "search.match.wholeDetail",
  fuzzy: "search.match.fuzzyDetail",
  regex: "search.match.regexDetail"
};

export function SearchView({
  indexer,
  drives,
  onAnalyze,
  onMigrate,
  notify,
  onRequestForceDelete,
  standalone = false
}: SearchViewProps) {
  const { t, ui, runtimeText, formatNumber } = useI18n();
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(defaultFilters);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [extensionInput, setExtensionInput] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("any");
  const [contentScope, setContentScope] = useState("*");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
  const [nameCursor, setNameCursor] = useState<string>();
  const [contentCursor, setContentCursor] = useState<string>();
  const [nameHasMore, setNameHasMore] = useState(false);
  const [contentHasMore, setContentHasMore] = useState(false);
  const [nameTotal, setNameTotal] = useState<number>();
  const [contentTotal, setContentTotal] = useState<number>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [columnWidths, setColumnWidths] = useState<SearchResultColumnWidths>({
    ...DEFAULT_SEARCH_COLUMN_WIDTHS
  });
  const [directorySizes, setDirectorySizes] = useState<Map<string, DirectorySizeResult>>(
    new Map()
  );
  const [directorySizesLoading, setDirectorySizesLoading] = useState(false);
  const [contentStatus, setContentStatus] = useState<ContentIndexerStatus>({
    state: "idle",
    root: "",
    filesVisited: 0,
    filesIndexed: 0
  });
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState<number>();
  const [error, setError] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState("");
  const [bookmarks, setBookmarks] = useState<SearchBookmark[]>([]);
  const [bookmarkFolders, setBookmarkFolders] = useState<SearchBookmarkFolder[]>([]);
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [selectedBookmarkFolder, setSelectedBookmarkFolder] = useState("all");
  const [savingBookmark, setSavingBookmark] = useState(false);
  const [draggingBookmarkId, setDraggingBookmarkId] = useState("");
  const [folderDropTarget, setFolderDropTarget] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState("");
  const [renamingFolderName, setRenamingFolderName] = useState("");
  const [bookmarkMenu, setBookmarkMenu] = useState<{
    x: number;
    y: number;
    folderId?: string;
  }>();
  const [contextMenu, setContextMenu] = useState<{
    item: SearchResult;
    x: number;
    y: number;
    initialRename?: boolean;
  }>();
  const [propertyPath, setPropertyPath] = useState("");
  const [forceDeletePath, setForceDeletePath] = useState("");
  const [liveIndexRevision, setLiveIndexRevision] = useState(0);
  const requestSequence = useRef(0);
  const pageRequestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const sizeSequence = useRef(0);
  const skipRestoredSearchRef = useRef(false);
  const skipRestoredSizesRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bookmarkPanelRef = useRef<HTMLElement>(null);
  const workspaceSnapshotRef = useRef<SearchWorkspaceState | undefined>(undefined);
  const liveRefreshRef = useRef(false);
  const resultsRef = useRef<SearchResult[]>([]);
  const contentResultsRef = useRef<ContentSearchResult[]>([]);
  const columnWidthsRef = useRef(columnWidths);
  const columnResizeRef = useRef<{
    boundary: number;
    pointerId: number;
    startX: number;
    tableWidth: number;
    widths: SearchResultColumnWidths;
  } | undefined>(undefined);
  const {
    feedback: openFeedback,
    openPath,
    openFromDoubleClick,
    classNameFor: openClassNameFor
  } = usePathOpenFeedback(notify);

  const categories = filters.categories ?? [];
  const scopes = filters.scopes ?? [];
  const extensions = filters.extensions ?? [];
  const contentStatusMatchesScope =
    contentScope !== "*" &&
    normalizeScopePath(contentStatus.root) === normalizeScopePath(contentScope);
  const contentReadyRevision =
    mode === "content" && contentStatus.state === "ready" && contentStatusMatchesScope
      ? `${normalizeScopePath(contentStatus.root)}:${contentStatus.filesIndexed}`
      : "";

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    contentResultsRef.current = contentResults;
  }, [contentResults]);

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getUiLayout()
      .then((layout) => {
        if (cancelled || !layout.searchResultColumnWidths) return;
        columnWidthsRef.current = layout.searchResultColumnWidths;
        setColumnWidths(layout.searchResultColumnWidths);
      })
      .catch((reason) =>
        console.warn("Unable to restore search result column widths", reason)
      );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => document.documentElement.classList.remove("resizing-search-columns"),
    []
  );

  useEffect(() => {
    if (!bookmarkPanelOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !bookmarkPanelRef.current?.contains(target) &&
        !(target instanceof Element && target.closest(".bookmark-context-menu"))
      ) {
        setBookmarkPanelOpen(false);
      }
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [bookmarkPanelOpen]);

  const contentIndexingCurrentScope =
    mode === "content" && contentStatus.state === "indexing" && contentStatusMatchesScope;
  const regexValidation = useMemo(
    () => validateRegexPattern(query),
    [query]
  );

  useEffect(() => api.onContentIndexerStatus(setContentStatus), []);

  useEffect(() => {
    if (!query.trim()) return;
    let timer: number | undefined;
    const unsubscribe = api.onSearchIndexChanged((event) => {
      if (mode === "content") {
        const currentScope = normalizeScopePath(contentScope);
        if (
          contentScope === "*" ||
          !event.contentScopes?.some(
            (scope) => normalizeScopePath(scope) === currentScope
          )
        ) {
          return;
        }
      }
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        liveRefreshRef.current = true;
        setLiveIndexRevision((revision) => revision + 1);
      }, 240);
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [contentScope, mode, query]);

  useEffect(() => {
    if (!query.trim()) return;
    let lastRefresh = 0;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRefresh < 1_000) return;
      lastRefresh = now;
      liveRefreshRef.current = true;
      setLiveIndexRevision((revision) => revision + 1);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.listSearchBookmarks(),
      api.listSearchBookmarkFolders()
    ])
      .then(([items, folders]) => {
        if (cancelled) return;
        setBookmarks(items);
        setBookmarkFolders(folders);
      })
      .catch((reason) =>
        console.warn("Unable to restore search bookmark shelf", reason)
      );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bookmarkMenu) return;
    const close = () => setBookmarkMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [bookmarkMenu]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSearchWorkspace()
      .then((workspace) => {
        if (cancelled || !workspace) return;
        setMode(workspace.mode);
        setQuery(workspace.query);
        setFilters(workspace.filters);
        setFilterPanelOpen(workspace.filterPanelOpen);
        setExtensionInput(workspace.extensionInput);
        setDatePreset(workspace.datePreset);
        setContentScope(workspace.contentScope);
        setResults(workspace.results);
        setContentResults(workspace.contentResults);
        setNameCursor(undefined);
        setContentCursor(undefined);
        setNameHasMore(workspace.mode === "name" && workspace.results.length >= NAME_PAGE_SIZE);
        setContentHasMore(
          workspace.mode === "content" && workspace.contentResults.length >= CONTENT_PAGE_SIZE
        );
        const restoredSizes = workspace.directorySizes ?? [];
        setDirectorySizes(
          new Map(
            restoredSizes.map((item) => [normalizeScopePath(item.path), item])
          )
        );
        skipRestoredSearchRef.current =
          Boolean(workspace.query.trim()) &&
          (workspace.mode === "name"
            ? workspace.results.length > 0
            : workspace.contentResults.length > 0);
        skipRestoredSizesRef.current =
          workspace.mode === "name" && restoredSizes.length > 0;
        setSelectedPath(workspace.selectedPath);
        setElapsed(workspace.elapsed);
        setRestoredAt(workspace.savedAt);
      })
      .catch((reason) => {
        console.warn("Unable to restore search workspace", reason);
      })
      .finally(() => {
        if (!cancelled) setWorkspaceReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspaceReady) return;
    const workspace: SearchWorkspaceState = {
      version: 1,
      mode,
      query,
      filters,
      filterPanelOpen,
      extensionInput,
      datePreset,
      contentScope,
      results,
      contentResults,
      directorySizes: [...directorySizes.values()],
      selectedPath,
      elapsed,
      savedAt: new Date().toISOString()
    };
    workspaceSnapshotRef.current = workspace;
    const timer = window.setTimeout(() => {
      void api
        .saveSearchWorkspace(workspace)
        .catch((reason) => console.warn("Unable to save search workspace", reason));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    contentResults,
    contentScope,
    datePreset,
    elapsed,
    extensionInput,
    filterPanelOpen,
    filters,
    directorySizes,
    mode,
    query,
    results,
    selectedPath,
    workspaceReady
  ]);

  useEffect(
    () => () => {
      if (workspaceSnapshotRef.current) {
        void api.saveSearchWorkspace(workspaceSnapshotRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) {
        return;
      }
      const item = results.find((result) => result.path === selectedPath);
      if (!item) return;
      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        setPropertyPath(item.path);
      } else if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        void api.revealPath(item.path);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void openPath(item.path);
      } else if (event.key === "Delete") {
        event.preventDefault();
        if (event.shiftKey) {
          setForceDeletePath(item.path);
          return;
        }
        void api
          .trashPath(item.path)
          .then((deleted) => {
            if (!deleted) return;
            setResults((items) => items.filter((candidate) => candidate.path !== item.path));
            notify("success", ui("已移入回收站", "Moved to the Recycle Bin"));
          })
          .catch((reason) =>
            notify("error", reason instanceof Error ? reason.message : String(reason))
          );
      } else if (event.key === "F2") {
        event.preventDefault();
        setContextMenu({
          item,
          x: Math.max(12, window.innerWidth / 2 - 180),
          y: Math.max(12, window.innerHeight / 2 - 260),
          initialRename: true
        });
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "c"
      ) {
        event.preventDefault();
        void api.copyText(item.path).then(() =>
          notify("success", ui("完整路径已复制", "Full path copied"))
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [notify, openPath, results, selectedPath]);

  useEffect(() => {
    if (mode !== "content" || contentScope === "*") return;
    let cancelled = false;
    void api
      .contentIndexStatus(contentScope)
      .then((status) => {
        if (!cancelled) setContentStatus(status);
      })
      .catch((reason) => {
        if (!cancelled) {
          setContentStatus({
            state: "error",
            root: contentScope,
            filesVisited: 0,
            filesIndexed: 0,
            message: reason instanceof Error ? reason.message : String(reason)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contentScope, mode]);

  useEffect(() => {
    if (!workspaceReady) return;
    if (skipRestoredSearchRef.current) {
      skipRestoredSearchRef.current = false;
      liveRefreshRef.current = true;
      window.setTimeout(
        () => setLiveIndexRevision((revision) => revision + 1),
        0
      );
      return;
    }
    const value = query.trim();
    if (!value) {
      setResults([]);
      setContentResults([]);
      setNameCursor(undefined);
      setContentCursor(undefined);
      setNameHasMore(false);
      setContentHasMore(false);
      setNameTotal(undefined);
      setContentTotal(undefined);
      setElapsed(undefined);
      setError("");
      return;
    }
    if (mode === "content" && contentScope === "*") {
      setContentResults([]);
      setError(
        ui(
          "内容搜索需要先选择一个明确目录，避免无意中扫描整台电脑。",
          "Choose a specific directory before content search to avoid scanning the entire computer."
        )
      );
      return;
    }
    if (filters.regex && !regexValidation.valid) {
      setResults([]);
      setContentResults([]);
      setElapsed(undefined);
      setError(regexValidation.message);
      return;
    }
    if (contentIndexingCurrentScope) {
      setContentResults([]);
      setElapsed(undefined);
      setError("");
      return;
    }

    const sequence = ++requestSequence.current;
    ++pageRequestSequence.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    const backgroundRefresh = liveRefreshRef.current;
    liveRefreshRef.current = false;
    const timer = window.setTimeout(() => {
      const started = performance.now();
      if (!backgroundRefresh) {
        setLoading(true);
        setDirectorySizes(new Map());
      }
      setError("");
      const refreshLimit =
        mode === "name"
          ? Math.max(NAME_PAGE_SIZE, resultsRef.current.length)
          : Math.max(CONTENT_PAGE_SIZE, contentResultsRef.current.length);
      const request =
        mode === "name"
          ? api.searchPage(
              value,
              {
                ...filters,
                kind: deriveKind(categories),
                scope: scopes[0] ?? "*",
                scopes
              },
              { limit: backgroundRefresh ? refreshLimit : NAME_PAGE_SIZE }
            )
          : api.searchContentPage(value, contentScope, {
              regex: filters.regex,
              caseSensitive: filters.caseSensitive,
              sortBy: filters.sortBy,
              sortDirection: filters.sortDirection,
              minSize: filters.minSize,
              maxSize: filters.maxSize,
              modifiedAfter: filters.modifiedAfter,
              modifiedBefore: filters.modifiedBefore,
              limit: backgroundRefresh ? refreshLimit : CONTENT_PAGE_SIZE
            });
      void request
        .then((page) => {
          if (sequence !== requestSequence.current) return;
          if (mode === "name") {
            const next = page.items as SearchResult[];
            setResults((current) =>
              searchResultsEqual(current, next) ? current : next
            );
            setNameCursor(page.nextCursor);
            setNameHasMore(page.hasMore);
            setNameTotal(page.totalMatches);
            setSelectedPath((current) =>
              current && next.some((item) => item.path === current)
                ? current
                : next[0]?.path ?? ""
            );
            setContentResults([]);
            setContentCursor(undefined);
            setContentHasMore(false);
            setContentTotal(undefined);
          } else {
            setContentResults(page.items as ContentSearchResult[]);
            setContentCursor(page.nextCursor);
            setContentHasMore(page.hasMore);
            setContentTotal(page.totalMatches);
            setResults([]);
            setNameCursor(undefined);
            setNameHasMore(false);
            setNameTotal(undefined);
          }
          setElapsed(performance.now() - started);
        })
        .catch((reason) => {
          if (sequence !== requestSequence.current) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (sequence === requestSequence.current && !backgroundRefresh) setLoading(false);
        });
    }, mode === "name" ? 110 : 180);
    return () => window.clearTimeout(timer);
  }, [
    categories,
    contentIndexingCurrentScope,
    contentReadyRevision,
    contentScope,
    filters,
    liveIndexRevision,
    mode,
    query,
    regexValidation.message,
    regexValidation.valid,
    scopes,
    workspaceReady
  ]);

  useEffect(() => {
    if (!workspaceReady) return;
    if (skipRestoredSizesRef.current) {
      skipRestoredSizesRef.current = false;
      setDirectorySizesLoading(false);
      return;
    }
    const paths = results
      .filter(
        (item) =>
          item.isDirectory && !directorySizes.has(normalizeScopePath(item.path))
      )
      .slice(0, 180)
      .map((item) => item.path);
    const sequence = ++sizeSequence.current;
    if (paths.length === 0) {
      setDirectorySizesLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setDirectorySizesLoading(true);
      void api
        .directorySizes(paths)
        .then((items) => {
          if (sequence !== sizeSequence.current) return;
          setDirectorySizes((current) => {
            const next = new Map(current);
            for (const item of items) {
              next.set(normalizeScopePath(item.path), item);
            }
            return next;
          });
        })
        .catch((reason) => {
          if (sequence === sizeSequence.current) {
            notify(
              "error",
              ui("部分文件夹大小计算失败：", "Some folder sizes could not be calculated: ") +
                (reason instanceof Error ? reason.message : String(reason))
            );
          }
        })
        .finally(() => {
          if (sequence === sizeSequence.current) setDirectorySizesLoading(false);
        });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [notify, results, workspaceReady]);

  const displayedResults = useMemo(() => {
    return results.map((item) => {
      const directorySize = item.isDirectory
        ? directorySizes.get(normalizeScopePath(item.path))
        : undefined;
      return directorySize ? { ...item, size: directorySize.bytes } : item;
    });
  }, [directorySizes, results]);

  const activeResultCount =
    mode === "name" ? displayedResults.length : contentResults.length;
  const activeHasMore = mode === "name" ? nameHasMore : contentHasMore;
  const virtualList = useVirtualList(
    activeResultCount,
    mode === "name" ? 58 : 82,
    10
  );
  const virtualNameResults = displayedResults.slice(
    virtualList.start,
    virtualList.end
  );
  const virtualContentResults = contentResults.slice(
    virtualList.start,
    virtualList.end
  );

  useEffect(() => {
    virtualList.resetScroll();
  }, [contentScope, filters, mode, query, virtualList.resetScroll]);

  const loadMoreResults = useCallback(async () => {
    const value = query.trim();
    const hasMore = mode === "name" ? nameHasMore : contentHasMore;
    if (!value || !hasMore || loading || loadingMoreRef.current) return;
    const sequence = ++pageRequestSequence.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    try {
      if (mode === "name") {
        const restoredBootstrap = !nameCursor && resultsRef.current.length > 0;
        const page = await api.searchPage(
          value,
          {
            ...filters,
            kind: deriveKind(categories),
            scope: scopes[0] ?? "*",
            scopes
          },
          {
            cursor: nameCursor,
            limit: restoredBootstrap
              ? Math.min(10_000, resultsRef.current.length + NAME_PAGE_SIZE)
              : NAME_PAGE_SIZE
          }
        );
        if (sequence !== pageRequestSequence.current) return;
        setResults((current) =>
          restoredBootstrap || page.cursorReset
            ? page.items
            : mergeSearchResults(current, page.items)
        );
        setNameCursor(page.nextCursor);
        setNameHasMore(page.hasMore);
        setNameTotal(page.totalMatches);
      } else {
        const restoredBootstrap = !contentCursor && contentResultsRef.current.length > 0;
        const page = await api.searchContentPage(value, contentScope, {
          regex: filters.regex,
          caseSensitive: filters.caseSensitive,
          sortBy: filters.sortBy,
          sortDirection: filters.sortDirection,
          minSize: filters.minSize,
          maxSize: filters.maxSize,
          modifiedAfter: filters.modifiedAfter,
          modifiedBefore: filters.modifiedBefore,
          cursor: contentCursor,
          limit: restoredBootstrap
            ? Math.min(2_000, contentResultsRef.current.length + CONTENT_PAGE_SIZE)
            : CONTENT_PAGE_SIZE
        });
        if (sequence !== pageRequestSequence.current) return;
        setContentResults((current) =>
          restoredBootstrap || page.cursorReset
            ? page.items
            : mergeContentResults(current, page.items)
        );
        setContentCursor(page.nextCursor);
        setContentHasMore(page.hasMore);
        setContentTotal(page.totalMatches);
      }
    } catch (reason) {
      if (sequence === pageRequestSequence.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (sequence === pageRequestSequence.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [
    categories,
    contentCursor,
    contentHasMore,
    contentScope,
    filters,
    loading,
    loadingMore,
    mode,
    nameCursor,
    nameHasMore,
    query,
    scopes
  ]);

  const handleResultScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      virtualList.onScroll(event);
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 720) {
        void loadMoreResults();
      }
    },
    [loadMoreResults, virtualList]
  );

  useEffect(() => {
    if (!activeHasMore || loading || loadingMore) return;
    const frame = window.requestAnimationFrame(() => {
      const element = virtualList.containerRef.current;
      if (element && element.scrollHeight <= element.clientHeight + 360) {
        void loadMoreResults();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeResultCount,
    activeHasMore,
    loadMoreResults,
    loading,
    loadingMore,
    virtualList.containerRef
  ]);

  const chooseScope = async () => {
    const selected = await api.chooseDirectory(
      mode === "content"
        ? ui("选择要建立内容索引的目录", "Choose a directory to index")
        : ui("选择搜索范围", "Choose a search scope"),
      mode === "content" ? "content-index" : "search-scope"
    );
    if (!selected) return;
    if (mode === "content") {
      setContentScope(selected);
      setContentResults([]);
      setContentStatus({
        state: "idle",
        root: selected,
        filesVisited: 0,
        filesIndexed: 0
      });
    } else {
      setFilters((current) => ({ ...current, scope: selected, scopes: [selected] }));
    }
    setError("");
  };

  const beginContentIndex = async () => {
    if (contentScope === "*") {
      await chooseScope();
      return;
    }
    setError("");
    setContentResults([]);
    setElapsed(undefined);
    setContentStatus({
      state: "indexing",
      root: contentScope,
      filesVisited: 0,
      filesIndexed: 0,
      message: ui("正在准备内容索引", "Preparing the content index")
    });
    try {
      await api.indexContent(contentScope);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setContentStatus({
        state: "error",
        root: contentScope,
        filesVisited: 0,
        filesIndexed: 0,
        message
      });
    }
  };

  const clearContentScope = () => {
    ++requestSequence.current;
    ++pageRequestSequence.current;
    setContentScope("*");
    setContentResults([]);
    setContentCursor(undefined);
    setContentHasMore(false);
    setContentTotal(undefined);
    setElapsed(undefined);
    setError("");
    setContentStatus({
      state: "idle",
      root: "*",
      filesVisited: 0,
      filesIndexed: 0
    });
  };

  const toggleCategory = (value: SearchCategory) => {
    setFilters((current) => {
      const currentCategories = current.categories ?? [];
      const next = currentCategories.includes(value)
        ? currentCategories.filter((item) => item !== value)
        : [...currentCategories, value];
      return { ...current, categories: next };
    });
  };

  const toggleDrive = (root: string) => {
    setFilters((current) => {
      const currentScopes = current.scopes ?? [];
      const next = currentScopes.includes(root)
        ? currentScopes.filter((item) => item !== root)
        : [...currentScopes, root];
      return { ...current, scope: next[0] ?? "*", scopes: next };
    });
  };

  const updateExtensions = () => {
    const parsed = [
      ...new Set(
        extensionInput
          .split(/[\s,;|]+/)
          .map((item) => item.trim().replace(/^\*\./, "").replace(/^\./, "").toLocaleLowerCase())
          .filter((item) => /^[a-z0-9_+-]{1,24}$/i.test(item))
      )
    ];
    setFilters((current) => ({ ...current, extensions: parsed }));
    setExtensionInput(parsed.join(", "));
  };

  const selectDatePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset !== "custom") {
      setFilters((current) => ({
        ...current,
        modifiedAfter: startOfPreset(preset),
        modifiedBefore: undefined
      }));
    }
  };

  const setSort = (field: SearchSortField) => {
    setFilters((current) => {
      const direction: SearchSortDirection =
        current.sortBy === field
          ? current.sortDirection === "asc"
            ? "desc"
            : "asc"
          : field === "relevance" || field === "size" || field === "modified"
            ? "desc"
            : "asc";
      return { ...current, sortBy: field, sortDirection: direction };
    });
  };

  const resultGridStyle = useMemo<CSSProperties>(
    () => ({
      gridTemplateColumns: SEARCH_COLUMN_KEYS.map(
        (key) => `${columnWidths[key]}fr`
      ).join(" ")
    }),
    [columnWidths]
  );

  const resizeColumnBoundary = useCallback(
    (
      boundary: number,
      deltaPercentage: number,
      base = columnWidthsRef.current
    ) => {
      const leftKey = SEARCH_COLUMN_KEYS[boundary];
      const rightKey = SEARCH_COLUMN_KEYS[boundary + 1];
      if (!leftKey || !rightKey) return;
      const pairWidth = base[leftKey] + base[rightKey];
      const leftWidth = Math.min(
        pairWidth - MIN_SEARCH_COLUMN_WIDTHS[rightKey],
        Math.max(
          MIN_SEARCH_COLUMN_WIDTHS[leftKey],
          base[leftKey] + deltaPercentage
        )
      );
      const next = {
        ...base,
        [leftKey]: leftWidth,
        [rightKey]: pairWidth - leftWidth
      };
      columnWidthsRef.current = next;
      setColumnWidths(next);
    },
    []
  );

  const beginColumnResize = useCallback(
    (boundary: number, event: ReactPointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const table = event.currentTarget.closest(".result-columns");
      if (!(table instanceof HTMLElement) || table.clientWidth <= 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      columnResizeRef.current = {
        boundary,
        pointerId: event.pointerId,
        startX: event.clientX,
        tableWidth: table.clientWidth,
        widths: { ...columnWidthsRef.current }
      };
      document.documentElement.classList.add("resizing-search-columns");
    },
    []
  );

  const moveColumnResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      const resize = columnResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      resizeColumnBoundary(
        resize.boundary,
        ((event.clientX - resize.startX) / resize.tableWidth) * 100,
        resize.widths
      );
    },
    [resizeColumnBoundary]
  );

  const finishColumnResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      const resize = columnResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      columnResizeRef.current = undefined;
      document.documentElement.classList.remove("resizing-search-columns");
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      void api
        .updateUiLayout({ searchResultColumnWidths: columnWidthsRef.current })
        .catch((reason) =>
          console.warn("Unable to save search result column widths", reason)
        );
    },
    []
  );

  const resetColumnWidths = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const next = { ...DEFAULT_SEARCH_COLUMN_WIDTHS };
    columnWidthsRef.current = next;
    setColumnWidths(next);
    void api
      .updateUiLayout({ searchResultColumnWidths: next })
      .catch((reason) =>
        console.warn("Unable to reset search result column widths", reason)
      );
  }, []);

  const adjustColumnWidthByKeyboard = useCallback(
    (boundary: number, event: ReactKeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      resizeColumnBoundary(boundary, event.key === "ArrowLeft" ? -1 : 1);
      void api
        .updateUiLayout({ searchResultColumnWidths: columnWidthsRef.current })
        .catch((reason) =>
          console.warn("Unable to save search result column widths", reason)
        );
    },
    [resizeColumnBoundary]
  );

  const resetFilters = () => {
    setFilters(defaultFilters());
    setExtensionInput("");
    setDatePreset("any");
  };

  const nameMatchMode: NameMatchMode = filters.regex
    ? "regex"
    : filters.fuzzy
      ? "fuzzy"
      : filters.wholeWord
        ? "whole"
        : "contains";

  const selectNameMatchMode = useCallback((value: NameMatchMode) => {
    setFilters((current) => ({
      ...current,
      wholeWord: value === "whole",
      fuzzy: value === "fuzzy",
      regex: value === "regex"
    }));
  }, []);

  const insertRegexToken = (token: string) => {
    const input = searchInputRef.current;
    const start = input?.selectionStart ?? query.length;
    const end = input?.selectionEnd ?? start;
    const next = `${query.slice(0, start)}${token}${query.slice(end)}`;
    setQuery(next);
    window.requestAnimationFrame(() => {
      const caret = start + token.length;
      searchInputRef.current?.focus();
      searchInputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const useRegexTemplate = (pattern: string) => {
    setQuery(pattern);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.setSelectionRange(pattern.length, pattern.length);
    });
  };

  const activeFilterCount =
    categories.length +
    scopes.length +
    extensions.length +
    Number(filters.minSize != null || filters.maxSize != null) +
    Number(filters.modifiedAfter != null || filters.modifiedBefore != null) +
    Number(filters.caseSensitive) +
    Number(filters.wholeWord) +
    Number(filters.fuzzy) +
    Number(filters.matchPath) +
    Number(filters.regex);

  const currentBookmarkSignature = bookmarkSignature({
    mode,
    query,
    filters,
    filterPanelOpen,
    extensionInput,
    datePreset,
    contentScope
  });

  const knownBookmarkFolderIds = new Set(bookmarkFolders.map((folder) => folder.id));
  const unfiledBookmarkCount = bookmarks.filter(
    (bookmark) => !bookmark.folderId || !knownBookmarkFolderIds.has(bookmark.folderId)
  ).length;
  const visibleBookmarks =
    selectedBookmarkFolder === "all"
      ? bookmarks
      : selectedBookmarkFolder === "unfiled"
        ? bookmarks.filter(
            (bookmark) =>
              !bookmark.folderId || !knownBookmarkFolderIds.has(bookmark.folderId)
          )
        : bookmarks.filter(
            (bookmark) => bookmark.folderId === selectedBookmarkFolder
          );
  const selectedBookmarkFolderLabel =
    selectedBookmarkFolder === "all"
      ? ui("全部收藏", "All saved searches")
      : selectedBookmarkFolder === "unfiled"
        ? ui("未分组", "Unfiled")
        : bookmarkFolders.find((folder) => folder.id === selectedBookmarkFolder)?.name ??
          ui("全部收藏", "All saved searches");

  const saveBookmark = async () => {
    if (!query.trim()) {
      notify("error", ui("请先输入要保存的搜索内容", "Enter a query before saving this search"));
      return;
    }
    if (
      bookmarks.some(
        (bookmark) => bookmarkSignature(bookmark) === currentBookmarkSignature
      )
    ) {
      notify("success", ui("当前搜索和筛选条件已经在书签中", "This query and its filters are already saved"));
      return;
    }
    const baseName = query.trim().slice(0, 48);
    const existingNames = new Set(
      bookmarks.map((bookmark) => bookmark.name.toLocaleLowerCase())
    );
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} (${suffix})`.slice(0, 80);
      suffix += 1;
    }
    const now = new Date().toISOString();
    const bookmark: SearchBookmark = {
      id: crypto.randomUUID(),
      name,
      folderId:
        selectedBookmarkFolder !== "all" &&
        selectedBookmarkFolder !== "unfiled" &&
        knownBookmarkFolderIds.has(selectedBookmarkFolder)
          ? selectedBookmarkFolder
          : undefined,
      mode,
      query: query.trim(),
      filters: structuredClone(filters),
      filterPanelOpen,
      extensionInput,
      datePreset,
      contentScope,
      createdAt: now,
      updatedAt: now
    };
    setSavingBookmark(true);
    try {
      const saved = await api.saveSearchBookmark(bookmark);
      setBookmarks((items) => [
        saved,
        ...items.filter((item) => item.id !== saved.id)
      ]);
      setBookmarkPanelOpen(true);
      notify("success", ui("搜索内容和全部筛选条件已添加为书签", "The query and all filters were saved"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSavingBookmark(false);
    }
  };

  const createBookmarkFolder = async () => {
    const baseName = ui("新建文件夹", "New folder");
    const existingNames = new Set(
      bookmarkFolders.map((folder) => folder.name.toLocaleLowerCase())
    );
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    const now = new Date().toISOString();
    const folder: SearchBookmarkFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      updatedAt: now
    };
    try {
      const saved = await api.saveSearchBookmarkFolder(folder);
      setBookmarkFolders((items) => [...items, saved]);
      setSelectedBookmarkFolder(saved.id);
      setRenamingFolderId(saved.id);
      setRenamingFolderName(saved.name);
      setBookmarkMenu(undefined);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const commitFolderRename = async (folderId: string) => {
    const folder = bookmarkFolders.find((item) => item.id === folderId);
    const name = renamingFolderName.trim().slice(0, 80);
    setRenamingFolderId("");
    if (!folder || !name || name === folder.name) return;
    try {
      const saved = await api.saveSearchBookmarkFolder({ ...folder, name });
      setBookmarkFolders((items) =>
        items.map((item) => (item.id === saved.id ? saved : item))
      );
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const deleteBookmarkFolder = async (folderId: string) => {
    try {
      const deleted = await api.deleteSearchBookmarkFolder(folderId);
      if (!deleted) return;
      setBookmarkFolders((items) => items.filter((item) => item.id !== folderId));
      setBookmarks((items) =>
        items.map((bookmark) =>
          bookmark.folderId === folderId
            ? { ...bookmark, folderId: undefined }
            : bookmark
        )
      );
      if (selectedBookmarkFolder === folderId) {
        setSelectedBookmarkFolder("unfiled");
      }
      setBookmarkMenu(undefined);
      notify("success", ui("文件夹已删除，其中的书签已移到“未分组”", "Folder deleted; its saved searches were moved to Unfiled"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const moveBookmarkToFolder = async (
    bookmarkId: string,
    folderId?: string
  ) => {
    const bookmark = bookmarks.find((item) => item.id === bookmarkId);
    setFolderDropTarget("");
    setDraggingBookmarkId("");
    if (!bookmark || bookmark.folderId === folderId) return;
    try {
      const saved = await api.saveSearchBookmark({
        ...bookmark,
        folderId,
        updatedAt: new Date().toISOString()
      });
      setBookmarks((items) =>
        items.map((item) => (item.id === saved.id ? saved : item))
      );
      notify(
        "success",
        folderId
          ? ui("书签已移入", "Saved search moved to") + ` “${bookmarkFolders.find((item) => item.id === folderId)?.name ?? ui("文件夹", "folder")}”`
          : ui("书签已移到“未分组”", "Saved search moved to Unfiled")
      );
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const beginBookmarkDrag = (
    event: DragEvent<HTMLDivElement>,
    bookmarkId: string
  ) => {
    setDraggingBookmarkId(bookmarkId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-cdriveshiftai-bookmark", bookmarkId);
    event.dataTransfer.setData("text/plain", bookmarkId);
  };

  const dropBookmark = (
    event: DragEvent<HTMLElement>,
    folderId?: string
  ) => {
    event.preventDefault();
    const bookmarkId =
      event.dataTransfer.getData("application/x-cdriveshiftai-bookmark") ||
      draggingBookmarkId;
    if (bookmarkId) void moveBookmarkToFolder(bookmarkId, folderId);
  };

  const showBookmarkMenu = (
    event: MouseEvent<HTMLElement>,
    folderId?: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setBookmarkMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 170),
      folderId
    });
  };

  const applyBookmark = (bookmark: SearchBookmark) => {
    setMode(bookmark.mode);
    setQuery(bookmark.query);
    setFilters(structuredClone(bookmark.filters));
    setFilterPanelOpen(bookmark.filterPanelOpen);
    setExtensionInput(bookmark.extensionInput);
    setDatePreset(bookmark.datePreset);
    setContentScope(bookmark.contentScope);
    setSelectedPath("");
    setRestoredAt("");
    setError("");
    setBookmarkPanelOpen(false);
    if (bookmark.mode === "content") {
      setContentStatus({
        state: "idle",
        root: bookmark.contentScope,
        filesVisited: 0,
        filesIndexed: 0
      });
    }
  };

  const deleteBookmark = async (id: string) => {
    try {
      await api.deleteSearchBookmark(id);
      setBookmarks((items) => items.filter((item) => item.id !== id));
      notify("success", ui("搜索书签已删除", "Saved search deleted"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const showResultMenu = (event: MouseEvent, item: SearchResult) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPath(item.path);
    setContextMenu({
      item,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 360)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 650))
    });
  };

  const removeResult = useCallback((targetPath: string) => {
    setResults((items) => items.filter((item) => item.path !== targetPath));
    setContentResults((items) => items.filter((item) => item.path !== targetPath));
    setSelectedPath("");
  }, []);

  useEffect(() => {
    if (!forceDeletePath || !onRequestForceDelete) return;
    onRequestForceDelete(forceDeletePath, removeResult);
    setForceDeletePath("");
  }, [forceDeletePath, onRequestForceDelete, removeResult]);

  const renameResult = useCallback((oldPath: string, newPath: string) => {
    const name = newPath.split(/[\\/]/).pop() ?? newPath;
    setResults((items) =>
      items.map((item) => (item.path === oldPath ? { ...item, path: newPath, name } : item))
    );
    setContentResults((items) =>
      items.map((item) => (item.path === oldPath ? { ...item, path: newPath, name } : item))
    );
    setSelectedPath(newPath);
  }, []);

  const searchWithin = (targetPath: string, content: boolean) => {
    if (content) {
      setMode("content");
      setContentScope(targetPath);
      setContentStatus({
        state: "idle",
        root: targetPath,
        filesVisited: 0,
        filesIndexed: 0
      });
    } else {
      setMode("name");
      setFilters((current) => ({ ...current, scope: targetPath, scopes: [targetPath] }));
    }
  };

  const scopeLabel =
    mode === "content"
      ? contentScope === "*"
        ? t("search.chooseContentDirectory")
        : contentScope
      : scopes.length === 0
        ? t("search.entireComputer")
        : scopes.length === 1
          ? scopes[0]
          : ui(`${scopes.length} 个范围`, `${formatNumber(scopes.length)} scopes`);
  const count = mode === "name" ? displayedResults.length : contentResults.length;
  const totalCount = mode === "name" ? nameTotal : contentTotal;
  const resultCountLabel =
    totalCount != null
      ? ui(
          `已加载 ${count.toLocaleString()} / 共 ${totalCount.toLocaleString()} 个`,
          `Loaded ${formatNumber(count)} of ${formatNumber(totalCount)}`
        )
      : ui(
          `${count.toLocaleString()}${activeHasMore ? "+" : ""} 个结果`,
          `${formatNumber(count)}${activeHasMore ? "+" : ""} results`
        );
  const columnResizeHandle = (boundary: number, label: string) => (
    <span
      className="result-column-resizer"
      role="separator"
      aria-label={ui(`调整${label}列宽`, `Resize ${label} column`)}
      aria-orientation="vertical"
      tabIndex={0}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={resetColumnWidths}
      onPointerDown={(event) => beginColumnResize(boundary, event)}
      onPointerMove={moveColumnResize}
      onPointerUp={finishColumnResize}
      onPointerCancel={finishColumnResize}
      onKeyDown={(event) => adjustColumnWidthByKeyboard(boundary, event)}
    />
  );

  return (
    <div className={standalone ? "page search-page standalone-search-page" : "page search-page"}>
      <div className="search-mode-toolbar">
        <div className="search-mode-switch">
          <button type="button" className={mode === "name" ? "active" : ""} onClick={() => setMode("name")}>
            <Search size={17} />
            <span>
              <strong>{t("search.nameMode")}</strong>
              <small>{t("search.nameModeDescription")}</small>
            </span>
          </button>
          <button
            type="button"
            className={mode === "content" ? "active" : ""}
            onClick={() => setMode("content")}
          >
            <FileSearch size={17} />
            <span>
              <strong>{t("search.contentMode")}</strong>
              <small>{t("search.contentModeDescription")}</small>
            </span>
          </button>
        </div>
        {!standalone && (
          <Badge tone={indexer.state === "ready" ? "good" : "warn"}>
            <Database size={13} />
            {indexer.state === "ready"
              ? ui(
                  `${indexer.entries.toLocaleString()} 条名称索引`,
                  `${formatNumber(indexer.entries)} names indexed`
                )
              : ui("全盘索引构建中", "Building the full-drive index")}
          </Badge>
        )}
      </div>

      <section
        ref={bookmarkPanelRef}
        className={`search-bookmark-strip glass-card ${
          bookmarkPanelOpen ? "expanded" : ""
        }`}
        aria-label={ui("已存搜索", "Saved searches")}
        onContextMenu={(event) => showBookmarkMenu(event)}
      >
        <button
          type="button"
          className="search-bookmark-toggle"
          aria-expanded={bookmarkPanelOpen}
          onClick={() => setBookmarkPanelOpen((open) => !open)}
        >
          <span className="search-bookmark-label">
            <Bookmark size={14} />
            <strong>{ui("已存搜索", "Saved searches")}</strong>
            <small>{bookmarks.length}</small>
          </span>
          <span className="search-bookmark-summary">
            {bookmarks.length === 0
              ? ui(
                  "保存关键字与全部筛选条件，可一键再次搜索",
                  "Save the query and every filter for one-click reuse"
                )
              : ui(
                  `${selectedBookmarkFolderLabel} · ${visibleBookmarks.length} 项`,
                  `${selectedBookmarkFolderLabel} · ${formatNumber(visibleBookmarks.length)} items`
                )}
          </span>
          <span className="search-bookmark-toggle-action">
            {bookmarkPanelOpen ? ui("收起", "Collapse") : ui("展开", "Expand")}
            <ChevronDown size={14} className={bookmarkPanelOpen ? "flip" : ""} />
          </span>
        </button>
        {bookmarkPanelOpen && (
          <div className="search-bookmark-dropdown">
            <div className="bookmark-folder-rail">
          <button
            type="button"
            className={selectedBookmarkFolder === "all" ? "active" : ""}
            onClick={() => setSelectedBookmarkFolder("all")}
          >
            <Bookmark size={12} />
            {ui("全部", "All")}
            <small>{bookmarks.length}</small>
          </button>
          <button
            type="button"
            className={`${selectedBookmarkFolder === "unfiled" ? "active" : ""} ${
              folderDropTarget === "unfiled" ? "drop-target" : ""
            }`}
            onClick={() => setSelectedBookmarkFolder("unfiled")}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setFolderDropTarget("unfiled");
            }}
            onDragLeave={() => setFolderDropTarget("")}
            onDrop={(event) => dropBookmark(event)}
          >
            <FolderOpen size={12} />
            {ui("未分组", "Unfiled")}
            <small>{unfiledBookmarkCount}</small>
          </button>
          {bookmarkFolders.map((folder) => {
            const count = bookmarks.filter(
              (bookmark) => bookmark.folderId === folder.id
            ).length;
            return (
              <div
                className={`bookmark-folder-chip ${
                  selectedBookmarkFolder === folder.id ? "active" : ""
                } ${folderDropTarget === folder.id ? "drop-target" : ""}`}
                key={folder.id}
                onContextMenu={(event) => showBookmarkMenu(event, folder.id)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setFolderDropTarget(folder.id);
                }}
                onDragLeave={() => setFolderDropTarget("")}
                onDrop={(event) => dropBookmark(event, folder.id)}
              >
                {renamingFolderId === folder.id ? (
                  <input
                    value={renamingFolderName}
                    onChange={(event) => setRenamingFolderName(event.target.value)}
                    onBlur={() => void commitFolderRename(folder.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void commitFolderRename(folder.id);
                      }
                      if (event.key === "Escape") setRenamingFolderId("");
                    }}
                    onClick={(event) => event.stopPropagation()}
                    maxLength={80}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setSelectedBookmarkFolder(folder.id)}
                  >
                    <Folder size={12} />
                    <span>{folder.name}</span>
                    <small>{count}</small>
                  </button>
                )}
              </div>
            );
          })}
          <span className="bookmark-folder-hint">
            <FolderPlus size={11} /> {ui("右键新建 · 拖动归类", "Right-click to create · drag to organize")}
          </span>
            </div>
            <div className="search-bookmark-list">
          {visibleBookmarks.length > 0 ? (
            visibleBookmarks.map((bookmark) => {
              const active =
                bookmarkSignature(bookmark) === currentBookmarkSignature;
              return (
                <div
                  className={`search-bookmark-chip ${active ? "active" : ""} ${
                    draggingBookmarkId === bookmark.id ? "dragging" : ""
                  }`}
                  key={bookmark.id}
                  draggable
                  onDragStart={(event) => beginBookmarkDrag(event, bookmark.id)}
                  onDragEnd={() => {
                    setDraggingBookmarkId("");
                    setFolderDropTarget("");
                  }}
                >
                  <button
                    type="button"
                    className="bookmark-apply"
                    onClick={() => applyBookmark(bookmark)}
                  >
                    <span>{bookmark.name}</span>
                    <small>
                      {bookmark.mode === "name" ? ui("名称", "Name") : ui("正文", "Content")} ·{" "}
                      {ui(
                        `${bookmarkConditionCount(bookmark)} 项条件`,
                        `${formatNumber(bookmarkConditionCount(bookmark))} filters`
                      )}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="bookmark-delete"
                    aria-label={ui(`删除搜索书签 ${bookmark.name}`, `Delete saved search ${bookmark.name}`)}
                    onClick={() => void deleteBookmark(bookmark.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })
          ) : (
            <span className="search-bookmark-empty">
              {bookmarks.length === 0
                ? ui(
                    "点击搜索框右侧“添加书签”即可立即保存",
                    "Use Save search beside the query box to save it immediately"
                  )
                : ui(
                    "这个文件夹还没有书签，可从“全部”中拖入",
                    "This folder is empty; drag saved searches here from All"
                  )}
            </span>
          )}
            </div>
          </div>
        )}
      </section>

      <section className="search-console glass-card">
        <div className="search-input-wrap">
          {mode === "name" ? <Search size={23} /> : <FileText size={23} />}
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              mode === "name"
                ? filters.regex
                  ? ui("输入正则表达式，例如 ^报告.*\\.pdf$", "Enter a regular expression, for example ^report.*\\.pdf$")
                  : filters.fuzzy
                    ? ui("输入模糊关键词，例如 rdscp 可匹配 redscope", "Enter a fuzzy query, for example rdscp matches redscope")
                  : ui("搜索任意磁盘中的文件、目录或文件夹名字…", "Search file and folder names on any drive…")
                : filters.regex
                  ? ui("输入正文正则，例如 error\\s+[45]\\d{2}", "Enter a content regex, for example error\\s+[45]\\d{2}")
                  : ui("搜索文件正文、代码、配置或日志内容…", "Search text, source code, configuration, or log contents…")
            }
            spellCheck={false}
          />
          {loading && <span className="spinner" />}
          {query && (
            <button
              className="add-search-bookmark"
              type="button"
              disabled={savingBookmark}
              onClick={() => void saveBookmark()}
            >
              <BookmarkPlus size={15} />
              <span>{savingBookmark ? ui("添加中…", "Saving…") : ui("添加书签", "Save search")}</span>
            </button>
          )}
          {query && !loading && (
            <button type="button" onClick={() => setQuery("")} aria-label={ui("清空搜索", "Clear search")}>
              <X size={18} />
            </button>
          )}
          <kbd>Ctrl K</kbd>
        </div>

        {mode === "name" ? (
          <>
            <div className="search-filter-workbench">
              <section className="search-filter-group search-filter-types">
                <div className="search-filter-group-title">
                  <File size={13} />
                  <span>{t("search.fileTypes")}</span>
                </div>
                <div className="quick-category-row">
                  <button
                    type="button"
                    className={categories.length === 0 ? "active" : ""}
                    onClick={() => setFilters((current) => ({ ...current, categories: [] }))}
                  >
                    {t("search.category.all")}
                  </button>
                  {categoryDefinitions.map(({ value, label, icon: Icon }) => (
                    <button
                      type="button"
                      className={categories.includes(value) ? "active" : ""}
                      onClick={() => toggleCategory(value)}
                      key={value}
                    >
                      <Icon size={13} />
                      {t(label)}
                    </button>
                  ))}
                </div>
              </section>

              <div className="search-filter-workbench-row">
                <section className="search-filter-group search-filter-location">
                  <div className="search-filter-group-title">
                    <Globe2 size={13} />
                    <span>{t("search.location")}</span>
                  </div>
                  <div className="search-filter-location-controls">
                    <div className="drive-scope-pills" aria-label={ui("磁盘范围，可多选", "Drive scope; multiple selections allowed")}>
                      <button
                        type="button"
                        className={scopes.length === 0 ? "active" : ""}
                        onClick={() => setFilters((current) => ({ ...current, scope: "*", scopes: [] }))}
                      >
                        <Globe2 size={12} /> {t("search.allComputer")}
                      </button>
                      {drives.map((drive) => (
                        <button
                          type="button"
                          className={scopes.includes(drive.root) ? "active" : ""}
                          onClick={() => toggleDrive(drive.root)}
                          key={drive.root}
                        >
                          {drive.root.slice(0, 2)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className={`scope-button ${scopes.length === 0 ? "default-scope" : ""}`}
                      onClick={() => void chooseScope()}
                    >
                      {scopes.length === 0 ? <Globe2 size={14} /> : <FolderOpen size={14} />}
                      <span>{scopeLabel}</span>
                    </button>
                  </div>
                </section>

                <section className="search-filter-group search-filter-match">
                  <div className="search-filter-group-title">
                    <FileSearch size={13} />
                    <span>{t("search.matchMode")}</span>
                  </div>
                  <div className="match-mode-segments" role="radiogroup" aria-label={ui("名称匹配方式", "Name match mode")}>
                    {(Object.keys(nameMatchModeLabels) as NameMatchMode[]).map((value) => (
                      <ThemedTooltip content={t(nameMatchModeDetails[value])} key={value}>
                        <button
                          type="button"
                          className={nameMatchMode === value ? "active" : ""}
                          role="radio"
                          aria-checked={nameMatchMode === value}
                          onClick={() => selectNameMatchMode(value)}
                        >
                          <span />
                          {t(nameMatchModeLabels[value])}
                        </button>
                      </ThemedTooltip>
                    ))}
                  </div>
                </section>

                <section className="search-filter-group search-filter-order">
                  <div className="search-filter-group-title">
                    <ListFilter size={13} />
                    <span>{t("search.sortAndProperties")}</span>
                    {elapsed != null && (
                      <small className="latency">
                        <Zap size={11} /> {elapsed < 1 ? "<1" : elapsed.toFixed(0)} ms
                      </small>
                    )}
                  </div>
                  <div className="search-filter-order-controls">
                    <div className="sort-control">
                      <ListFilter size={13} />
                      <select
                        value={filters.sortBy}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            sortBy: event.target.value as SearchSortField
                          }))
                        }
                      >
                        {(Object.keys(sortLabels) as SearchSortField[]).map((field) => (
                          <option value={field} key={field}>
                            {t("search.sortBy", { field: t(sortLabels[field]) })}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={filters.sortDirection === "asc"
                          ? ui("当前升序，点击切换降序", "Ascending; switch to descending")
                          : ui("当前降序，点击切换升序", "Descending; switch to ascending")}
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            sortDirection: current.sortDirection === "asc" ? "desc" : "asc"
                          }))
                        }
                      >
                        {filters.sortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                      </button>
                    </div>
                    <button
                      type="button"
                      className={filterPanelOpen ? "advanced-filter-button active" : "advanced-filter-button"}
                      onClick={() => setFilterPanelOpen((value) => !value)}
                    >
                      <SlidersHorizontal size={14} />
                      {t("search.moreConditions")}
                      {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
                      <ChevronDown size={13} className={filterPanelOpen ? "flip" : ""} />
                    </button>
                  </div>
                </section>
              </div>
            </div>

            {filterPanelOpen && (
              <div className="advanced-filter-panel">
                <div className="advanced-filter-grid">
                  <section>
                    <label>{ui("指定扩展名（支持多个）", "File extensions (multiple allowed)")}</label>
                    <div className="filter-input-line">
                      <input
                        value={extensionInput}
                        onChange={(event) => setExtensionInput(event.target.value)}
                        onBlur={updateExtensions}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") updateExtensions();
                        }}
                        placeholder="pdf, docx, zip, exe"
                      />
                      <button type="button" onClick={updateExtensions}>
                        {ui("应用", "Apply")}
                      </button>
                    </div>
                  </section>
                  <section>
                    <label>{ui("大小范围（MB，文件夹完成计算后生效）", "Size range (MB; folders apply after calculation)")}</label>
                    <div className="size-range-inputs">
                      <input
                        type="number"
                        min="0"
                        value={filters.minSize == null ? "" : Math.round(filters.minSize / 1024 ** 2)}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            minSize: event.target.value ? Number(event.target.value) * 1024 ** 2 : undefined
                          }))
                        }
                        placeholder={ui("最小", "Minimum")}
                      />
                      <span>—</span>
                      <input
                        type="number"
                        min="0"
                        value={filters.maxSize == null ? "" : Math.round(filters.maxSize / 1024 ** 2)}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            maxSize: event.target.value ? Number(event.target.value) * 1024 ** 2 : undefined
                          }))
                        }
                        placeholder={ui("最大", "Maximum")}
                      />
                    </div>
                    <div className="preset-pills">
                      {[
                        [ui("任意", "Any"), undefined, undefined],
                        ["≤1 MB", undefined, 1024 ** 2],
                        ["1–100 MB", 1024 ** 2, 100 * 1024 ** 2],
                        ["≥100 MB", 100 * 1024 ** 2, undefined],
                        ["≥1 GB", 1024 ** 3, undefined]
                      ].map(([label, minimum, maximum]) => (
                        <button
                          type="button"
                          onClick={() =>
                            setFilters((current) => ({
                              ...current,
                              minSize: minimum as number | undefined,
                              maxSize: maximum as number | undefined
                            }))
                          }
                          key={String(label)}
                        >
                          {String(label)}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section>
                    <label>{ui("修改时间", "Modified date")}</label>
                    <div className="preset-pills date-presets">
                      {(
                        [
                          ["any", ui("任意", "Any time")],
                          ["today", ui("今天", "Today")],
                          ["week", ui("近 7 天", "Last 7 days")],
                          ["month", ui("近 30 天", "Last 30 days")],
                          ["year", ui("近一年", "Last year")],
                          ["custom", ui("自定义", "Custom")]
                        ] as Array<[DatePreset, string]>
                      ).map(([value, label]) => (
                        <button
                          type="button"
                          className={datePreset === value ? "active" : ""}
                          onClick={() => selectDatePreset(value)}
                          key={value}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {datePreset === "custom" && (
                      <div className="date-range-inputs">
                        <input
                          type="date"
                          onChange={(event) =>
                            setFilters((current) => ({
                              ...current,
                              modifiedAfter: event.target.value
                                ? new Date(`${event.target.value}T00:00:00`).toISOString()
                                : undefined
                            }))
                          }
                        />
                        <span>{ui("至", "to")}</span>
                        <input
                          type="date"
                          onChange={(event) =>
                            setFilters((current) => ({
                              ...current,
                              modifiedBefore: event.target.value
                                ? new Date(`${event.target.value}T23:59:59`).toISOString()
                                : undefined
                            }))
                          }
                        />
                      </div>
                    )}
                  </section>
                  <section>
                    <label>{ui("名称匹配规则", "Name matching rules")}</label>
                    <div className="search-option-toggles">
                      {[
                        ["matchPath", ui("匹配完整路径", "Match full path")],
                        ["caseSensitive", ui("区分大小写", "Case sensitive")]
                      ].map(([field, label]) => (
                        <button
                          type="button"
                          className={filters[field as keyof SearchFilters] ? "active" : ""}
                          onClick={() =>
                            setFilters((current) => ({
                              ...current,
                              [field]: !current[field as keyof SearchFilters]
                            }))
                          }
                          key={field}
                        >
                          <span />
                          {label}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <div className="advanced-filter-footer">
                  <span>
                    {ui(
                      "同一组内按“或”组合，不同组之间按“且”组合；模糊、正则和完整路径模式可能稍慢。",
                      "Values within a group use OR; separate groups use AND. Fuzzy, regex, and full-path modes can be slower."
                    )}
                  </span>
                  <button type="button" onClick={resetFilters}>
                    <RotateCcw size={13} /> {ui("重置全部筛选", "Reset all filters")}
                  </button>
                </div>
              </div>
            )}

            {activeFilterCount > 0 && (
              <div className="active-filter-chips">
                <span>{ui("当前组合", "Active filters")}</span>
                {scopes.map((scope) => (
                  <button type="button" onClick={() => toggleDrive(scope)} key={scope}>
                    {ui("范围：", "Scope: ")}{scope} <X size={11} />
                  </button>
                ))}
                {categories.map((category) => (
                  <button type="button" onClick={() => toggleCategory(category)} key={category}>
                    {t(categoryLabels[category])} <X size={11} />
                  </button>
                ))}
                {extensions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((current) => ({ ...current, extensions: [] }));
                      setExtensionInput("");
                    }}
                  >
                    {ui("扩展名：", "Extensions: ")}{extensions.join(" / ")} <X size={11} />
                  </button>
                )}
                {(filters.minSize != null || filters.maxSize != null) && (
                  <button
                    type="button"
                    onClick={() =>
                      setFilters((current) => ({
                        ...current,
                        minSize: undefined,
                        maxSize: undefined
                      }))
                    }
                  >
                    {ui("大小范围", "Size range")} <X size={11} />
                  </button>
                )}
                {(filters.modifiedAfter || filters.modifiedBefore) && (
                  <button type="button" onClick={() => selectDatePreset("any")}>
                    {ui("修改时间", "Modified date")} <X size={11} />
                  </button>
                )}
                {nameMatchMode !== "contains" && (
                  <button type="button" onClick={() => selectNameMatchMode("contains")}>
                    {t(nameMatchModeLabels[nameMatchMode])} <X size={11} />
                  </button>
                )}
                {filters.caseSensitive && (
                  <button
                    type="button"
                    onClick={() =>
                      setFilters((current) => ({ ...current, caseSensitive: false }))
                    }
                  >
                    {ui("区分大小写", "Case sensitive")} <X size={11} />
                  </button>
                )}
                {filters.matchPath && (
                  <button
                    type="button"
                    onClick={() => setFilters((current) => ({ ...current, matchPath: false }))}
                  >
                    {ui("匹配完整路径", "Match full path")} <X size={11} />
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="search-filters">
              <div className={`content-state ${contentStatus.state}`}>
                <span className={contentStatus.state === "indexing" ? "spinner tiny" : "status-dot online"} />
                {contentStatus.state === "indexing"
                  ? ui(
                      `已写入 ${contentStatus.filesIndexed.toLocaleString()} 个文档`,
                      `Indexed ${formatNumber(contentStatus.filesIndexed)} documents`
                    )
                  : contentStatus.state === "ready" && contentStatusMatchesScope
                    ? ui(
                        `${contentStatus.filesIndexed.toLocaleString()} 个文档已就绪`,
                        `${formatNumber(contentStatus.filesIndexed)} documents ready`
                      )
                    : ui("需要为所选目录建立内容索引", "Build a content index for the selected directory")}
              </div>
              <div className="scope-actions">
                <button type="button" className="scope-button" onClick={() => void chooseScope()}>
                  {contentScope === "*" ? <Globe2 size={14} /> : <FolderOpen size={14} />}
                  <span>{scopeLabel}</span>
                </button>
                {contentScope !== "*" && (
                  <button
                    type="button"
                    className="scope-clear-button"
                    title={t("search.clearContentDirectory")}
                    aria-label={t("search.clearContentDirectory")}
                    onClick={clearContentScope}
                  >
                    <FolderX size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="index-content-button"
                  disabled={contentStatus.state === "indexing"}
                  onClick={() => void beginContentIndex()}
                >
                  <RefreshCw size={14} className={contentStatus.state === "indexing" ? "spin" : ""} />
                  {contentStatus.state === "indexing"
                    ? ui("索引中", "Indexing")
                    : ui("建立/刷新索引", "Build / refresh index")}
                </button>
              </div>
              <div className="content-match-options search-option-toggles">
                <button
                  type="button"
                  className={filters.regex ? "active" : ""}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      regex: !current.regex,
                      wholeWord: false,
                      fuzzy: false
                    }))
                  }
                >
                  <span />
                  {ui("正则匹配", "Regular expression")}
                </button>
                <button
                  type="button"
                  className={filters.caseSensitive ? "active" : ""}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      caseSensitive: !current.caseSensitive
                    }))
                  }
                >
                  <span />
                  {ui("区分大小写", "Case sensitive")}
                </button>
              </div>
              {elapsed != null && (
                <span className="latency">
                  <Zap size={13} /> {elapsed < 1 ? "<1" : elapsed.toFixed(0)} ms
                </span>
              )}
            </div>
          </>
        )}

        {filters.regex && (
          <div className="regex-assistant" aria-label={ui("正则表达式补全助手", "Regular expression assistant")}>
            <div className={`regex-validation ${regexValidation.valid ? "valid" : "invalid"}`}>
              <Braces size={16} />
              <div>
                <strong>
                  {regexValidation.valid
                    ? ui("表达式有效", "Expression is valid")
                    : ui("正则补全助手", "Regex assistant")}
                </strong>
                <span>{runtimeText(regexValidation.message)}</span>
              </div>
              <small>
                {filters.caseSensitive
                  ? ui("区分大小写", "Case sensitive")
                  : ui("忽略大小写", "Ignore case")} ·{" "}
                {mode === "content"
                  ? ui("正文索引", "Content index")
                  : ui("文件与目录名称", "File and folder names")}
              </small>
            </div>
            <div className="regex-template-row">
              <span>{ui("常用模板", "Templates")}</span>
              {regexTemplates.map((template) => (
                <ThemedTooltip
                  content={`${ui(template.description, template.englishDescription)}: ${template.pattern}`}
                  key={template.name}
                >
                  <button
                    type="button"
                    onClick={() => useRegexTemplate(template.pattern)}
                  >
                    {ui(template.name, template.englishName)}
                  </button>
                </ThemedTooltip>
              ))}
            </div>
            <div className="regex-token-row">
              <span>{ui("在光标处补全", "Insert at cursor")}</span>
              {regexTokens.map((token) => (
                <ThemedTooltip
                  content={`${ui(token.hint, token.englishHint)}: ${token.value}`}
                  key={token.label}
                >
                  <button
                    type="button"
                    onClick={() => insertRegexToken(token.value)}
                  >
                    <code>{token.value}</code>
                    <small>{ui(token.label, token.englishLabel)}</small>
                  </button>
                </ThemedTooltip>
              ))}
            </div>
            <p>
              {ui("规则速记：", "Quick reference: ")}<code>.</code> {ui("任意字符，", "any character, ")}
              <code>*</code> {ui("零次或多次，", "zero or more, ")}
              <code>+</code> {ui("一次或多次，", "one or more, ")}
              <code>[]</code> {ui("字符范围，", "character range, ")}
              <code>|</code> {ui(
                "表示“或”。为保证线性时间和大索引稳定，不支持前后查找与反向引用。",
                "means OR. Lookaround and backreferences are disabled to keep large-index searches predictable."
              )}
            </p>
          </div>
        )}
      </section>

      {query ? (
        <section className="results-panel glass-card">
          <div className="results-head">
            <span>{loading ? ui("正在查询…", "Searching…") : resultCountLabel}</span>
            {loadingMore && (
              <span className="inline-note lazy-load-note">
                <span className="spinner tiny" /> {ui("正在加载下一批", "Loading next page")}
              </span>
            )}
            {restoredAt && (
              <ThemedTooltip content={ui(`保存时间：${restoredAt}`, `Saved at: ${restoredAt}`)}>
                <span className="inline-note restored-search-state">
                  <RotateCcw size={12} /> {ui("已恢复上次搜索 · 自动保存", "Previous search restored · autosaved")}
                </span>
              </ThemedTooltip>
            )}
            {mode === "name" && directorySizesLoading && (
              <span className="inline-note size-note">
                <span className="spinner tiny" /> {ui("正在后台计算文件夹占用空间", "Calculating folder sizes in the background")}
              </span>
            )}
            {mode === "name" && indexer.state !== "ready" && (
              <span className="inline-note">
                <Info size={13} /> {ui("全盘索引未完成，结果会持续补全", "The index is still building; results will keep appearing")}
              </span>
            )}
            {mode === "name" && indexer.state === "ready" && (
              <span className="inline-note live-search-note">
                <Zap size={12} /> {ui("索引变更实时同步", "Index changes synchronized live")}
              </span>
            )}
            {mode === "content" && contentStatusMatchesScope && contentStatus.message && (
              <span className="inline-note">
                <Info size={13} /> {runtimeText(contentStatus.message)}
              </span>
            )}
            <span className="result-help">{ui(
              "单击选中 · 双击打开 · 右键操作 · 拖动表头分隔线调列宽",
              "Click to select · double-click to open · right-click for actions · drag headers to resize"
            )}</span>
          </div>
          {mode === "name" && !error && displayedResults.length > 0 && (
            <div className="result-columns" style={resultGridStyle}>
              <button type="button" onClick={() => setSort("name")}>
                {ui("名称", "Name")}
                {filters.sortBy === "name" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                {columnResizeHandle(0, ui("名称", "Name"))}
              </button>
              <button type="button" onClick={() => setSort("path")}>
                {ui("路径", "Path")}
                {filters.sortBy === "path" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                {columnResizeHandle(1, ui("路径", "Path"))}
              </button>
              <button type="button" onClick={() => setSort("type")}>
                {ui("类型", "Type")}
                {filters.sortBy === "type" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                {columnResizeHandle(2, ui("类型", "Type"))}
              </button>
              <button type="button" onClick={() => setSort("size")}>
                {ui("大小", "Size")}
                {filters.sortBy === "size" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                {columnResizeHandle(3, ui("大小", "Size"))}
              </button>
              <button type="button" onClick={() => setSort("modified")}>
                {ui("修改时间", "Modified")}
                {filters.sortBy === "modified" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                {columnResizeHandle(4, ui("修改时间", "Modified"))}
              </button>
              <span>{ui("操作", "Actions")}</span>
            </div>
          )}
          {error ? (
            <EmptyState
              icon={<Info size={26} />}
              title={mode === "content"
                ? ui("内容索引尚未就绪", "Content index is not ready")
                : ui("搜索暂时不可用", "Search is temporarily unavailable")}
              action={
                mode === "content" ? (
                  <button className="primary-button small" type="button" onClick={() => void beginContentIndex()}>
                    <Database size={15} /> {ui("建立内容索引", "Build content index")}
                  </button>
                ) : undefined
              }
            >
              {error}
            </EmptyState>
          ) : mode === "name" && displayedResults.length > 0 ? (
            <div
              className="result-list virtual-result-list"
              ref={virtualList.containerRef}
              onScroll={handleResultScroll}
              aria-busy={loadingMore}
            >
              {virtualList.paddingTop > 0 && (
                <div className="virtual-list-spacer" style={{ height: virtualList.paddingTop }} />
              )}
              {virtualNameResults.map((item) => {
                const directorySize = item.isDirectory
                  ? directorySizes.get(normalizeScopePath(item.path))
                  : undefined;
                const category = categoryOf(item);
                return (
                  <div
                    className={`result-row result-grid-row path-openable ${
                      selectedPath === item.path ? "selected" : ""
                    } ${openClassNameFor(item.path)}`}
                    style={resultGridStyle}
                    key={item.path}
                    onClick={() => setSelectedPath(item.path)}
                    onDoubleClick={(event) => openFromDoubleClick(event, item.path)}
                    onContextMenu={(event) => showResultMenu(event, item)}
                    aria-selected={selectedPath === item.path}
                  >
                    <div className="result-name-cell">
                      <div className={`file-type-icon ${item.isDirectory ? "folder" : "file"}`}>
                        {item.isDirectory ? <Folder size={19} /> : <File size={18} />}
                      </div>
                      <strong>{item.name}</strong>
                    </div>
                    <ThemedTooltip content={item.path} wrap>
                      <span className="result-path-cell">{item.path}</span>
                    </ThemedTooltip>
                    <span className="result-type-cell">{t(categoryLabels[category])}</span>
                    <strong className="result-size-cell">
                      {item.isDirectory && !directorySize
                        ? directorySizesLoading
                          ? ui("计算中…", "Calculating…")
                          : "—"
                        : `${directorySize && !directorySize.complete ? "≥ " : ""}${formatBytes(item.size)}`}
                    </strong>
                    <span className="result-date-cell">{formatDate(item.modifiedAt)}</span>
                    <div className="result-row-action">
                      {item.isDirectory ? (
                        <>
                          <ThemedTooltip content={ui("分析这个文件夹归属于哪个应用、用途与迁移风险", "Analyze this folder's owning app, purpose, and migration risk")}>
                            <button
                              className="result-quick-action"
                              type="button"
                              aria-label={ui("分析目录归属", "Analyze folder ownership")}
                              onClick={(event) => {
                                event.stopPropagation();
                                onAnalyze(item.path);
                              }}
                            >
                              <Sparkles size={15} />
                            </button>
                          </ThemedTooltip>
                          <ThemedTooltip content={ui("将这个目录带入可恢复的安全迁移流程", "Send this folder to the recoverable migration workflow")}>
                            <button
                              className="result-quick-action migrate"
                              type="button"
                              aria-label={ui("进入安全迁移", "Open safe migration")}
                              onClick={(event) => {
                                event.stopPropagation();
                                onMigrate(item.path);
                              }}
                            >
                              <ArrowRightLeft size={15} />
                            </button>
                          </ThemedTooltip>
                        </>
                      ) : (
                        <ThemedTooltip content={ui("使用 Windows 当前默认应用打开文件", "Open with the current Windows default app")}>
                          <button
                            className="open-result-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openPath(item.path);
                            }}
                          >
                            <Play size={14} /> {ui("打开", "Open")}
                          </button>
                        </ThemedTooltip>
                      )}
                    </div>
                    <PathOpenFeedback path={item.path} feedback={openFeedback} />
                  </div>
                );
              })}
              {virtualList.paddingBottom > 0 && (
                <div
                  className="virtual-list-spacer"
                  style={{ height: virtualList.paddingBottom }}
                />
              )}
            </div>
          ) : mode === "content" && contentResults.length > 0 ? (
            <>
              <div className="content-result-columns" role="row">
                <span aria-hidden="true" />
                <span>{ui("文件 / 路径 / 命中内容", "File / path / matching content")}</span>
                <span>{ui("大小 / 修改时间", "Size / modified")}</span>
              </div>
              <div
                className="result-list content-results virtual-result-list"
                ref={virtualList.containerRef}
                onScroll={handleResultScroll}
                aria-busy={loadingMore}
              >
                {virtualList.paddingTop > 0 && (
                  <div
                    className="virtual-list-spacer"
                    style={{ height: virtualList.paddingTop }}
                  />
                )}
                {virtualContentResults.map((item) => {
                const contextItem: SearchResult = {
                  path: item.path,
                  name: item.name,
                  isDirectory: false,
                  size: item.size ?? 0,
                  modifiedAt: item.modifiedAt,
                  score: item.score,
                  source: "native-index"
                };
                return (
                  <div
                    className={`result-row content-row path-openable ${
                      selectedPath === item.path ? "selected" : ""
                    } ${openClassNameFor(item.path)}`}
                    key={item.path}
                    onClick={() => setSelectedPath(item.path)}
                    onDoubleClick={(event) => openFromDoubleClick(event, item.path)}
                    onContextMenu={(event) => showResultMenu(event, contextItem)}
                  >
                    <div className="file-type-icon file">
                      <FileText size={18} />
                    </div>
                    <div className="result-name content-result-main">
                      <strong>{item.name}</strong>
                      <span>{item.path}</span>
                      <p>{item.preview}</p>
                    </div>
                    <div className="content-result-meta">
                      <strong>{item.size != null ? formatBytes(item.size) : "—"}</strong>
                      <span>{formatDate(item.modifiedAt)}</span>
                    </div>
                    <PathOpenFeedback path={item.path} feedback={openFeedback} />
                  </div>
                );
                })}
                {virtualList.paddingBottom > 0 && (
                  <div
                    className="virtual-list-spacer"
                    style={{ height: virtualList.paddingBottom }}
                  />
                )}
              </div>
            </>
          ) : !loading ? (
            <EmptyState icon={<Search size={28} />} title={ui("没有找到匹配项", "No matching items")}>
              {mode === "name"
                ? ui("尝试移除部分组合筛选、缩短关键词或切换到整个电脑。", "Remove some filters, shorten the query, or search the entire computer.")
                : ui("确认内容索引已刷新，或尝试更短的原文片段。", "Refresh the content index or try a shorter source-text fragment.")}
            </EmptyState>
          ) : null}
        </section>
      ) : (
        <section className="search-idle">
          <div className="search-illustration">
            <div className="search-orbit o1" />
            <div className="search-orbit o2" />
            {mode === "name" ? <Search size={34} /> : <FileSearch size={34} />}
          </div>
          <h2>{mode === "name" ? t("search.emptyNameTitle") : t("search.emptyContentTitle")}</h2>
          <p>
            {mode === "name"
              ? ui("文件类型之间可多选，盘符也可多选；类型、范围、大小、日期与名称规则按“且”组合。", "Select multiple file types and drives; type, scope, size, date, and name rules are combined with AND.")
              : ui("适合代码仓库、日志目录和文档资料库；先建立一次索引，后续查询即时完成。", "Designed for repositories, logs, and document libraries. Build once, then query instantly.")}
          </p>
          <div className="example-chips">
            {(mode === "name"
              ? ["AppData cache", "node_modules", "Tencent", ".log"]
              : ["error 502", "TODO", ui("数据库连接", "database connection"), "api_key"]
            ).map((item) => (
              <button type="button" onClick={() => setQuery(item)} key={item}>
                {item}
              </button>
            ))}
          </div>
        </section>
      )}

      {bookmarkMenu &&
        createPortal(
          <div
            className="bookmark-context-menu"
            style={{ left: bookmarkMenu.x, top: bookmarkMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
          >
            <div className="bookmark-context-head">
              <FolderPlus size={14} />
              <span>
                {bookmarkMenu.folderId
                  ? bookmarkFolders.find(
                      (folder) => folder.id === bookmarkMenu.folderId
                    )?.name
                  : ui("已存搜索管理", "Saved search management")}
              </span>
            </div>
            <button type="button" onClick={() => void createBookmarkFolder()}>
              <FolderPlus size={14} />
              {ui("新建书签文件夹", "New saved-search folder")}
            </button>
            {bookmarkMenu.folderId && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const folder = bookmarkFolders.find(
                      (item) => item.id === bookmarkMenu.folderId
                    );
                    if (!folder) return;
                    setRenamingFolderId(folder.id);
                    setRenamingFolderName(folder.name);
                    setSelectedBookmarkFolder(folder.id);
                    setBookmarkMenu(undefined);
                  }}
                >
                  <Pencil size={14} />
                  {ui("重命名文件夹", "Rename folder")}
                </button>
                <div className="bookmark-context-separator" />
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void deleteBookmarkFolder(bookmarkMenu.folderId!)
                  }
                >
                  <FolderX size={14} />
                  {ui("删除文件夹并移出书签", "Delete folder and move out saved searches")}
                </button>
              </>
            )}
          </div>,
          document.body
        )}

      {contextMenu && (
        <SearchContextMenu
          {...contextMenu}
          key={contextMenu.item.path}
          onClose={() => setContextMenu(undefined)}
          onAnalyze={onAnalyze}
          onMigrate={onMigrate}
          onSearchWithin={searchWithin}
          onFindSameName={(name) => {
            setMode("name");
            setQuery(name);
          }}
          onFilterExtension={(extension) => {
            setMode("name");
            setExtensionInput(extension);
            setFilters((current) => ({ ...current, extensions: [extension] }));
          }}
          onProperties={setPropertyPath}
          onForceDelete={setForceDeletePath}
          onDeleted={removeResult}
          onRenamed={renameResult}
          notify={notify}
        />
      )}
      {propertyPath && (
        <PathPropertiesDialog
          path={propertyPath}
          onClose={() => setPropertyPath("")}
          onRenamed={(oldPath, newPath) => {
            renameResult(oldPath, newPath);
            setPropertyPath(newPath);
          }}
          notify={notify}
        />
      )}
      {forceDeletePath && !onRequestForceDelete && (
        <ForceDeleteDialog
          path={forceDeletePath}
          onClose={() => setForceDeletePath("")}
          onDeleted={removeResult}
          notify={notify}
        />
      )}
    </div>
  );
}

function searchResultsEqual(current: SearchResult[], next: SearchResult[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((item, index) => {
    const candidate = next[index];
    return (
      item.path === candidate.path &&
      item.name === candidate.name &&
      item.isDirectory === candidate.isDirectory &&
      item.size === candidate.size &&
      item.modifiedAt === candidate.modifiedAt &&
      item.score === candidate.score &&
      item.source === candidate.source
    );
  });
}

function mergeSearchResults(
  current: SearchResult[],
  next: SearchResult[]
): SearchResult[] {
  const paths = new Set(current.map((item) => normalizeScopePath(item.path)));
  const merged = [...current];
  for (const item of next) {
    const key = normalizeScopePath(item.path);
    if (paths.has(key)) continue;
    paths.add(key);
    merged.push(item);
  }
  return merged;
}

function mergeContentResults(
  current: ContentSearchResult[],
  next: ContentSearchResult[]
): ContentSearchResult[] {
  const paths = new Set(current.map((item) => normalizeScopePath(item.path)));
  const merged = [...current];
  for (const item of next) {
    const key = normalizeScopePath(item.path);
    if (paths.has(key)) continue;
    paths.add(key);
    merged.push(item);
  }
  return merged;
}
