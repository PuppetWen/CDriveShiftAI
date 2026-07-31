import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
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
import { PathPropertiesDialog } from "../components/PathPropertiesDialog";
import { ThemedTooltip } from "../components/ThemedTooltip";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, EmptyState, PageTitle } from "../components/ui";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
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
}

const categoryDefinitions: Array<{
  value: SearchCategory;
  label: string;
  icon: typeof Folder;
}> = [
  { value: "folder", label: "文件夹", icon: Folder },
  { value: "document", label: "文档", icon: FileText },
  { value: "image", label: "图片", icon: Image },
  { value: "video", label: "视频", icon: Film },
  { value: "audio", label: "音频", icon: AudioLines },
  { value: "archive", label: "压缩包", icon: Archive },
  { value: "executable", label: "程序", icon: FileCog },
  { value: "code", label: "代码", icon: Braces },
  { value: "other", label: "其他", icon: File }
];

const categoryLabels = Object.fromEntries(
  categoryDefinitions.map((item) => [item.value, item.label])
) as Record<SearchCategory, string>;

const sortLabels: Record<SearchSortField, string> = {
  relevance: "相关度",
  name: "名称",
  path: "路径",
  size: "大小",
  modified: "修改时间",
  type: "类型"
};

export function SearchView({
  indexer,
  drives,
  onAnalyze,
  onMigrate,
  notify,
  standalone = false
}: SearchViewProps) {
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(defaultFilters);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [extensionInput, setExtensionInput] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("any");
  const [contentScope, setContentScope] = useState("*");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
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
  const requestSequence = useRef(0);
  const sizeSequence = useRef(0);
  const skipRestoredSearchRef = useRef(false);
  const skipRestoredSizesRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bookmarkPanelRef = useRef<HTMLElement>(null);
  const workspaceSnapshotRef = useRef<SearchWorkspaceState | undefined>(undefined);
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
        void api
          .trashPath(item.path)
          .then((deleted) => {
            if (!deleted) return;
            setResults((items) => items.filter((candidate) => candidate.path !== item.path));
            notify("success", "已移入回收站");
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
        void api.copyText(item.path).then(() => notify("success", "完整路径已复制"));
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
      return;
    }
    const value = query.trim();
    if (!value) {
      setResults([]);
      setContentResults([]);
      setElapsed(undefined);
      setError("");
      return;
    }
    if (mode === "content" && contentScope === "*") {
      setContentResults([]);
      setError("内容搜索需要先选择一个明确目录，避免无意中扫描整台电脑。");
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
    const timer = window.setTimeout(() => {
      const started = performance.now();
      setLoading(true);
      setError("");
      const request =
        mode === "name"
          ? api.search(value, {
              ...filters,
              kind: deriveKind(categories),
              scope: scopes[0] ?? "*",
              scopes
            })
          : api.searchContent(value, contentScope, {
              regex: filters.regex,
              caseSensitive: filters.caseSensitive
            });
      void request
        .then((items) => {
          if (sequence !== requestSequence.current) return;
          if (mode === "name") {
            setResults(items as SearchResult[]);
            setContentResults([]);
          } else {
            setContentResults(items as ContentSearchResult[]);
            setResults([]);
          }
          setElapsed(performance.now() - started);
        })
        .catch((reason) => {
          if (sequence !== requestSequence.current) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (sequence === requestSequence.current) setLoading(false);
        });
    }, mode === "name" ? 110 : 180);
    return () => window.clearTimeout(timer);
  }, [
    categories,
    contentIndexingCurrentScope,
    contentReadyRevision,
    contentScope,
    filters,
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
    const paths = results.filter((item) => item.isDirectory).map((item) => item.path);
    const sequence = ++sizeSequence.current;
    setDirectorySizes(new Map());
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
          setDirectorySizes(
            new Map(items.map((item) => [normalizeScopePath(item.path), item]))
          );
        })
        .catch((reason) => {
          if (sequence === sizeSequence.current) {
            notify(
              "error",
              `部分文件夹大小计算失败：${reason instanceof Error ? reason.message : String(reason)}`
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
    const enriched = results
      .map((item) => {
        const directorySize = item.isDirectory
          ? directorySizes.get(normalizeScopePath(item.path))
          : undefined;
        return directorySize ? { ...item, size: directorySize.bytes } : item;
      })
      .filter((item) => {
        if (!item.isDirectory) return true;
        const size = directorySizes.get(normalizeScopePath(item.path));
        if (!size?.complete) return true;
        if (filters.minSize != null && size.bytes < filters.minSize) return false;
        if (filters.maxSize != null && size.bytes > filters.maxSize) return false;
        return true;
      });
    const field = filters.sortBy ?? "relevance";
    const direction = filters.sortDirection === "desc" ? -1 : 1;
    enriched.sort((first, second) => {
      let comparison = 0;
      if (field === "name") {
        comparison = first.name.localeCompare(second.name, "zh-CN", {
          numeric: true,
          sensitivity: "base"
        });
      } else if (field === "path") {
        comparison = first.path.localeCompare(second.path, "zh-CN", {
          numeric: true,
          sensitivity: "base"
        });
      } else if (field === "size") {
        comparison = first.size - second.size;
      } else if (field === "modified") {
        comparison =
          (first.modifiedAt ? Date.parse(first.modifiedAt) : 0) -
          (second.modifiedAt ? Date.parse(second.modifiedAt) : 0);
      } else if (field === "type") {
        comparison = categoryOf(first).localeCompare(categoryOf(second));
      } else {
        comparison = second.score - first.score;
        return comparison || first.path.length - second.path.length;
      }
      return comparison * direction || first.name.localeCompare(second.name, "zh-CN");
    });
    return enriched;
  }, [directorySizes, filters.maxSize, filters.minSize, filters.sortBy, filters.sortDirection, results]);

  const chooseScope = async () => {
    const selected = await api.chooseDirectory(
      mode === "content" ? "选择要建立内容索引的目录" : "选择搜索范围"
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
      message: "正在准备内容索引"
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

  const resetFilters = () => {
    setFilters(defaultFilters());
    setExtensionInput("");
    setDatePreset("any");
  };

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
      ? "全部收藏"
      : selectedBookmarkFolder === "unfiled"
        ? "未分组"
        : bookmarkFolders.find((folder) => folder.id === selectedBookmarkFolder)?.name ??
          "全部收藏";

  const saveBookmark = async () => {
    if (!query.trim()) {
      notify("error", "请先输入要保存的搜索内容");
      return;
    }
    if (
      bookmarks.some(
        (bookmark) => bookmarkSignature(bookmark) === currentBookmarkSignature
      )
    ) {
      notify("success", "当前搜索和筛选条件已经在书签中");
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
      notify("success", "搜索内容和全部筛选条件已添加为书签");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSavingBookmark(false);
    }
  };

  const createBookmarkFolder = async () => {
    const baseName = "新建文件夹";
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
      notify("success", "文件夹已删除，其中的书签已移到“未分组”");
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
          ? `书签已移入“${bookmarkFolders.find((item) => item.id === folderId)?.name ?? "文件夹"}”`
          : "书签已移到“未分组”"
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
      notify("success", "搜索书签已删除");
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
        ? "选择内容索引目录"
        : contentScope
      : scopes.length === 0
        ? "整个电脑"
        : scopes.length === 1
          ? scopes[0]
          : `${scopes.length} 个范围`;
  const count = mode === "name" ? displayedResults.length : contentResults.length;

  return (
    <div className={standalone ? "page search-page standalone-search-page" : "page search-page"}>
      {standalone ? (
        <div className="standalone-search-heading">
          <div>
            <span>FULL SEARCH WORKSPACE</span>
            <strong>全电脑搜索</strong>
            <small>与主程序共享搜索状态、筛选条件和已存搜索</small>
          </div>
          <Badge tone={indexer.state === "ready" ? "good" : "warn"}>
            <Database size={13} />
            {indexer.state === "ready"
              ? `${indexer.entries.toLocaleString()} 条名称索引`
              : "全盘索引构建中"}
          </Badge>
        </div>
      ) : (
        <PageTitle
          eyebrow="FIRST-PARTY SEARCH"
          title="全电脑，输入即达。"
          description="组合文件类型、盘符、扩展名、大小、日期和名称规则，并按任意列即时排序。"
          action={
            <Badge tone={indexer.state === "ready" ? "good" : "warn"}>
              <Database size={13} />
              {indexer.state === "ready"
                ? `${indexer.entries.toLocaleString()} 条名称索引`
                : "全盘索引构建中"}
            </Badge>
          }
        />
      )}

      <div className="search-mode-switch">
        <button type="button" className={mode === "name" ? "active" : ""} onClick={() => setMode("name")}>
          <Search size={17} />
          <span>
            <strong>名称搜索</strong>
            <small>全盘组合筛选</small>
          </span>
        </button>
        <button
          type="button"
          className={mode === "content" ? "active" : ""}
          onClick={() => setMode("content")}
        >
          <FileSearch size={17} />
          <span>
            <strong>内容搜索</strong>
            <small>指定目录全文</small>
          </span>
        </button>
      </div>

      <section
        ref={bookmarkPanelRef}
        className={`search-bookmark-strip glass-card ${
          bookmarkPanelOpen ? "expanded" : ""
        }`}
        aria-label="已存搜索"
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
            <strong>已存搜索</strong>
            <small>{bookmarks.length}</small>
          </span>
          <span className="search-bookmark-summary">
            {bookmarks.length === 0
              ? "保存关键字与全部筛选条件，可一键再次搜索"
              : `${selectedBookmarkFolderLabel} · ${visibleBookmarks.length} 项`}
          </span>
          <span className="search-bookmark-toggle-action">
            {bookmarkPanelOpen ? "收起" : "展开"}
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
            全部
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
            未分组
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
            <FolderPlus size={11} /> 右键新建 · 拖动归类
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
                      {bookmark.mode === "name" ? "名称" : "正文"} ·{" "}
                      {bookmarkConditionCount(bookmark)} 项条件
                    </small>
                  </button>
                  <button
                    type="button"
                    className="bookmark-delete"
                    aria-label={`删除搜索书签 ${bookmark.name}`}
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
                ? "点击搜索框右侧“添加书签”即可立即保存"
                : "这个文件夹还没有书签，可从“全部”中拖入"}
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
                  ? "输入正则表达式，例如 ^报告.*\\.pdf$"
                  : "搜索任意磁盘中的文件、目录或文件夹名字…"
                : filters.regex
                  ? "输入正文正则，例如 error\\s+[45]\\d{2}"
                  : "搜索文件正文、代码、配置或日志内容…"
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
              <span>{savingBookmark ? "添加中…" : "添加书签"}</span>
            </button>
          )}
          {query && !loading && (
            <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
              <X size={18} />
            </button>
          )}
          <kbd>Ctrl K</kbd>
        </div>

        {mode === "name" ? (
          <>
            <div className="search-filter-topline">
              <div className="quick-category-row">
                <button
                  type="button"
                  className={categories.length === 0 ? "active" : ""}
                  onClick={() => setFilters((current) => ({ ...current, categories: [] }))}
                >
                  全部
                </button>
                {categoryDefinitions.map(({ value, label, icon: Icon }) => (
                  <button
                    type="button"
                    className={categories.includes(value) ? "active" : ""}
                    onClick={() => toggleCategory(value)}
                    key={value}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={filterPanelOpen ? "advanced-filter-button active" : "advanced-filter-button"}
                onClick={() => setFilterPanelOpen((value) => !value)}
              >
                <SlidersHorizontal size={14} />
                高级筛选
                {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
                <ChevronDown size={13} className={filterPanelOpen ? "flip" : ""} />
              </button>
            </div>

            <div className="search-filters name-filter-row">
              <div className="drive-scope-pills" aria-label="磁盘范围，可多选">
                <button
                  type="button"
                  className={scopes.length === 0 ? "active" : ""}
                  onClick={() => setFilters((current) => ({ ...current, scope: "*", scopes: [] }))}
                >
                  <Globe2 size={12} /> 全电脑
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
              <button type="button" className="scope-button" onClick={() => void chooseScope()}>
                {scopes.length === 0 ? <Globe2 size={14} /> : <FolderOpen size={14} />}
                <span>{scopeLabel}</span>
              </button>
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
                      按{sortLabels[field]}排序
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={filters.sortDirection === "asc" ? "当前升序，点击切换降序" : "当前降序，点击切换升序"}
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
              {elapsed != null && (
                <span className="latency">
                  <Zap size={13} /> {elapsed < 1 ? "<1" : elapsed.toFixed(0)} ms
                </span>
              )}
            </div>

            {filterPanelOpen && (
              <div className="advanced-filter-panel">
                <div className="advanced-filter-grid">
                  <section>
                    <label>指定扩展名（支持多个）</label>
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
                        应用
                      </button>
                    </div>
                  </section>
                  <section>
                    <label>大小范围（MB，文件夹完成计算后生效）</label>
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
                        placeholder="最小"
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
                        placeholder="最大"
                      />
                    </div>
                    <div className="preset-pills">
                      {[
                        ["任意", undefined, undefined],
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
                    <label>修改时间</label>
                    <div className="preset-pills date-presets">
                      {(
                        [
                          ["any", "任意"],
                          ["today", "今天"],
                          ["week", "近 7 天"],
                          ["month", "近 30 天"],
                          ["year", "近一年"],
                          ["custom", "自定义"]
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
                        <span>至</span>
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
                    <label>名称匹配规则</label>
                    <div className="search-option-toggles">
                      {[
                        ["matchPath", "匹配完整路径"],
                        ["caseSensitive", "区分大小写"],
                        ["wholeWord", "完整单词"],
                        ["regex", "正则表达式"]
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
                    同一组内按“或”组合，不同组之间按“且”组合；正则和完整路径模式可能稍慢。
                  </span>
                  <button type="button" onClick={resetFilters}>
                    <RotateCcw size={13} /> 重置全部筛选
                  </button>
                </div>
              </div>
            )}

            {activeFilterCount > 0 && (
              <div className="active-filter-chips">
                <span>当前组合</span>
                {scopes.map((scope) => (
                  <button type="button" onClick={() => toggleDrive(scope)} key={scope}>
                    范围：{scope} <X size={11} />
                  </button>
                ))}
                {categories.map((category) => (
                  <button type="button" onClick={() => toggleCategory(category)} key={category}>
                    {categoryLabels[category]} <X size={11} />
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
                    扩展名：{extensions.join(" / ")} <X size={11} />
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
                    大小范围 <X size={11} />
                  </button>
                )}
                {(filters.modifiedAfter || filters.modifiedBefore) && (
                  <button type="button" onClick={() => selectDatePreset("any")}>
                    修改时间 <X size={11} />
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
                  ? `已写入 ${contentStatus.filesIndexed.toLocaleString()} 个文档`
                  : contentStatus.state === "ready" && contentStatusMatchesScope
                    ? `${contentStatus.filesIndexed.toLocaleString()} 个文档已就绪`
                    : "需要为所选目录建立内容索引"}
              </div>
              <div className="scope-actions">
                <button type="button" className="scope-button" onClick={() => void chooseScope()}>
                  {contentScope === "*" ? <Globe2 size={14} /> : <FolderOpen size={14} />}
                  <span>{scopeLabel}</span>
                </button>
                <button
                  type="button"
                  className="index-content-button"
                  disabled={contentStatus.state === "indexing"}
                  onClick={() => void beginContentIndex()}
                >
                  <RefreshCw size={14} className={contentStatus.state === "indexing" ? "spin" : ""} />
                  {contentStatus.state === "indexing" ? "索引中" : "建立/刷新索引"}
                </button>
              </div>
              <div className="content-match-options search-option-toggles">
                <button
                  type="button"
                  className={filters.regex ? "active" : ""}
                  onClick={() =>
                    setFilters((current) => ({ ...current, regex: !current.regex }))
                  }
                >
                  <span />
                  正则匹配
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
                  区分大小写
                </button>
              </div>
              {elapsed != null && (
                <span className="latency">
                  <Zap size={13} /> {elapsed < 1 ? "<1" : elapsed.toFixed(0)} ms
                </span>
              )}
            </div>
            <div className="content-privacy-note">
              <Info size={14} />
              只读取文本、代码、配置和日志；自动跳过 node_modules、.git、dist、build
              等依赖或生成目录，单文件上限 8 MB。
            </div>
          </>
        )}

        {filters.regex && (
          <div className="regex-assistant" aria-label="正则表达式补全助手">
            <div className={`regex-validation ${regexValidation.valid ? "valid" : "invalid"}`}>
              <Braces size={16} />
              <div>
                <strong>
                  {regexValidation.valid ? "表达式有效" : "正则补全助手"}
                </strong>
                <span>{regexValidation.message}</span>
              </div>
              <small>
                {filters.caseSensitive ? "区分大小写" : "忽略大小写"} ·{" "}
                {mode === "content" ? "正文索引" : "文件与目录名称"}
              </small>
            </div>
            <div className="regex-template-row">
              <span>常用模板</span>
              {regexTemplates.map((template) => (
                <ThemedTooltip
                  content={`${template.description}：${template.pattern}`}
                  key={template.name}
                >
                  <button
                    type="button"
                    onClick={() => useRegexTemplate(template.pattern)}
                  >
                    {template.name}
                  </button>
                </ThemedTooltip>
              ))}
            </div>
            <div className="regex-token-row">
              <span>在光标处补全</span>
              {regexTokens.map((token) => (
                <ThemedTooltip
                  content={`${token.hint}：${token.value}`}
                  key={token.label}
                >
                  <button
                    type="button"
                    onClick={() => insertRegexToken(token.value)}
                  >
                    <code>{token.value}</code>
                    <small>{token.label}</small>
                  </button>
                </ThemedTooltip>
              ))}
            </div>
            <p>
              规则速记：<code>.</code> 任意字符，<code>*</code> 零次或多次，
              <code>+</code> 一次或多次，<code>[]</code> 字符范围，
              <code>|</code> 表示“或”。为保证线性时间和大索引稳定，不支持前后查找与反向引用。
            </p>
          </div>
        )}
      </section>

      {query ? (
        <section className="results-panel glass-card">
          <div className="results-head">
            <span>{loading ? "正在查询…" : `${count} 个结果`}</span>
            {restoredAt && (
              <ThemedTooltip content={`保存时间：${restoredAt}`}>
                <span className="inline-note restored-search-state">
                  <RotateCcw size={12} /> 已恢复上次搜索 · 自动保存
                </span>
              </ThemedTooltip>
            )}
            {mode === "name" && directorySizesLoading && (
              <span className="inline-note size-note">
                <span className="spinner tiny" /> 正在后台计算文件夹占用空间
              </span>
            )}
            {mode === "name" && indexer.state !== "ready" && (
              <span className="inline-note">
                <Info size={13} /> 全盘索引未完成，结果会持续补全
              </span>
            )}
            {mode === "content" && contentStatusMatchesScope && contentStatus.message && (
              <span className="inline-note">
                <Info size={13} /> {contentStatus.message}
              </span>
            )}
            <span className="result-help">单击选中 · 双击打开 · 右键更多操作</span>
          </div>
          {mode === "name" && !error && displayedResults.length > 0 && (
            <div className="result-columns">
              <button type="button" onClick={() => setSort("name")}>
                名称
                {filters.sortBy === "name" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
              <button type="button" onClick={() => setSort("path")}>
                路径
                {filters.sortBy === "path" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
              <button type="button" onClick={() => setSort("type")}>
                类型
                {filters.sortBy === "type" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
              <button type="button" onClick={() => setSort("size")}>
                大小
                {filters.sortBy === "size" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
              <button type="button" onClick={() => setSort("modified")}>
                修改时间
                {filters.sortBy === "modified" &&
                  (filters.sortDirection === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
              <span>操作</span>
            </div>
          )}
          {error ? (
            <EmptyState
              icon={<Info size={26} />}
              title={mode === "content" ? "内容索引尚未就绪" : "搜索暂时不可用"}
              action={
                mode === "content" ? (
                  <button className="primary-button small" type="button" onClick={() => void beginContentIndex()}>
                    <Database size={15} /> 建立内容索引
                  </button>
                ) : undefined
              }
            >
              {error}
            </EmptyState>
          ) : mode === "name" && displayedResults.length > 0 ? (
            <div className="result-list">
              {displayedResults.map((item) => {
                const directorySize = item.isDirectory
                  ? directorySizes.get(normalizeScopePath(item.path))
                  : undefined;
                const category = categoryOf(item);
                return (
                  <div
                    className={`result-row result-grid-row path-openable ${
                      selectedPath === item.path ? "selected" : ""
                    } ${openClassNameFor(item.path)}`}
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
                    <ThemedTooltip content={item.path}>
                      <span className="result-path-cell">{item.path}</span>
                    </ThemedTooltip>
                    <span className="result-type-cell">{categoryLabels[category]}</span>
                    <strong className="result-size-cell">
                      {item.isDirectory && !directorySize
                        ? directorySizesLoading
                          ? "计算中…"
                          : "—"
                        : `${directorySize && !directorySize.complete ? "≥ " : ""}${formatBytes(item.size)}`}
                    </strong>
                    <span className="result-date-cell">{formatDate(item.modifiedAt)}</span>
                    <div className="result-row-action">
                      {item.isDirectory ? (
                        <ThemedTooltip content="分析这个文件夹归属于哪个应用、用途与迁移风险">
                          <button
                            className="analyze-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onAnalyze(item.path);
                            }}
                          >
                            <Sparkles size={14} /> 分析
                          </button>
                        </ThemedTooltip>
                      ) : (
                        <ThemedTooltip content="使用 Windows 当前默认应用打开文件">
                          <button
                            className="open-result-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openPath(item.path);
                            }}
                          >
                            <Play size={14} /> 打开
                          </button>
                        </ThemedTooltip>
                      )}
                    </div>
                    <PathOpenFeedback path={item.path} feedback={openFeedback} />
                  </div>
                );
              })}
            </div>
          ) : mode === "content" && contentResults.length > 0 ? (
            <>
              <div className="content-result-columns" role="row">
                <span aria-hidden="true" />
                <span>文件 / 路径 / 命中内容</span>
                <span>大小 / 修改时间</span>
              </div>
              <div className="result-list content-results">
                {contentResults.map((item) => {
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
              </div>
            </>
          ) : !loading ? (
            <EmptyState icon={<Search size={28} />} title="没有找到匹配项">
              {mode === "name"
                ? "尝试移除部分组合筛选、缩短关键词或切换到整个电脑。"
                : "确认内容索引已刷新，或尝试更短的原文片段。"}
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
          <h2>{mode === "name" ? "整个电脑的名字，输入即出现" : "在指定目录里，搜索文件正文"}</h2>
          <p>
            {mode === "name"
              ? "文件类型之间可多选，盘符也可多选；类型、范围、大小、日期与名称规则按“且”组合。"
              : "适合代码仓库、日志目录和文档资料库；先建立一次索引，后续查询即时完成。"}
          </p>
          <div className="example-chips">
            {(mode === "name"
              ? ["AppData cache", "node_modules", "Tencent", ".log"]
              : ["error 502", "TODO", "数据库连接", "api_key"]
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
                  : "已存搜索管理"}
              </span>
            </div>
            <button type="button" onClick={() => void createBookmarkFolder()}>
              <FolderPlus size={14} />
              新建书签文件夹
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
                  重命名文件夹
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
                  删除文件夹并移出书签
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
    </div>
  );
}
