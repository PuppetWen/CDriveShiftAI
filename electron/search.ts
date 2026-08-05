import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, lstat, opendir, stat } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import type {
  ContentIndexerStatus,
  ContentSearchOptions,
  ContentSearchResult,
  DirectorySizeResult,
  IndexerStatus,
  MouseShortcutButton,
  MouseShortcutStatus,
  NativeResponse,
  SearchIndexChangedEvent,
  SearchFilters,
  SearchPage,
  SearchPageOptions,
  SearchResult
} from "./types";
import { getLocalDriveRoots } from "./system";
import {
  determineIndexRefreshReason,
  INDEX_REFRESH_INTERVAL_MS
} from "./index-refresh-policy";
import { logger, serializeError } from "./logger";

interface PendingRequest {
  resolve: (response: NativeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

const wordCharacterPattern = /[\p{L}\p{N}_]/u;

function containsCompleteWord(target: string, needle: string): boolean {
  let start = target.indexOf(needle);
  while (start >= 0) {
    const before = Array.from(target.slice(0, start)).at(-1);
    const after = Array.from(target.slice(start + needle.length))[0];
    if (
      (!before || !wordCharacterPattern.test(before)) &&
      (!after || !wordCharacterPattern.test(after))
    ) {
      return true;
    }
    start = target.indexOf(needle, start + Math.max(1, needle.length));
  }
  return false;
}

function fuzzySubsequenceScore(target: string, needle: string): number | undefined {
  const wanted = Array.from(needle);
  if (wanted.length === 0) return undefined;
  let wantedIndex = 0;
  let first = -1;
  let last = -1;
  let consecutivePairs = 0;
  let position = 0;
  for (const character of target) {
    if (character === wanted[wantedIndex]) {
      if (first < 0) first = position;
      if (last >= 0 && position === last + 1) consecutivePairs += 1;
      last = position;
      wantedIndex += 1;
      if (wantedIndex === wanted.length) {
        const span = last - first + 1;
        return (
          48 +
          (wanted.length / Math.max(1, span)) * 22 +
          (consecutivePairs / Math.max(1, wanted.length - 1)) * 15 +
          (1 / (1 + first * 0.15)) * 9 +
          (needle.length / Math.max(needle.length, target.length)) * 6
        );
      }
    }
    position += 1;
  }
  return undefined;
}

export class SearchService {
  private child?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private status: IndexerStatus = {
    mode: "loading",
    state: "idle",
    entries: 0,
    progress: 0,
    root: "本机所有磁盘",
    message: "正在启动自研索引核心"
  };
  private stopping = false;
  private restartCount = 0;
  private executableCatalogCache?: { at: number; paths: string[] };
  private cachePath?: string;
  private dailyRefreshTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private stopPromise?: Promise<void>;
  private lastFullRefreshRequestedAt = 0;
  private backgroundMode = false;
  private mouseShortcutStatus: MouseShortcutStatus;

  constructor(
    private readonly onStatus: (status: IndexerStatus) => void,
    private readonly onContentStatus: (status: ContentIndexerStatus) => void,
    private readonly onIndexChanged: (event: SearchIndexChangedEvent) => void,
    private readonly onMouseShortcutHold: () => void,
    initialMouseShortcut: { button: MouseShortcutButton; holdMs: number }
  ) {
    this.mouseShortcutStatus = {
      available: false,
      button: initialMouseShortcut.button,
      holdMs: initialMouseShortcut.holdMs,
      message: "鼠标全局监听正在启动"
    };
  }

  async start(): Promise<void> {
    if (this.stopping || this.child) return;
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, "bin", "cshift-indexer.exe")
      : path.resolve(__dirname, "..", "native", "indexer", "target", "release", "cshift-indexer.exe");
    if (!(await fileExists(executable))) {
      this.updateStatus({
        mode: "unavailable",
        state: "error",
        entries: 0,
        progress: 0,
        root: "本机所有磁盘",
        message: "原生索引核心尚未构建；搜索将使用限时实时扫描"
      });
      return;
    }

    const child = spawn(executable, ["--serve"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    logger.info("indexer.spawn_requested", {
      executable,
      backgroundMode: this.backgroundMode
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.status.message = message.slice(-300);
      if (message) {
        logger.warn("indexer.stderr", { message: message.slice(-2_000) });
      }
      if (message && process.env.CDRIVESHIFTAI_TRIM_DIAGNOSTICS === "1") {
        process.stderr.write(`${message}\n`);
      }
    });
    // A pipe can close between the writable-state check and write(). Node emits
    // an "error" event in addition to invoking the write callback; without a
    // listener that EPIPE becomes an uncaught main-process exception.
    child.stdin.on("error", (error) => {
      logger.warn("indexer.stdin_error", {
        stopping: this.stopping,
        error: serializeError(error)
      });
      if (this.child === child) this.rejectPending(error);
    });
    child.on("error", (error) => {
      logger.error("indexer.process_error", {
        stopping: this.stopping,
        error: serializeError(error)
      });
      if (this.child === child) this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      logger.info("indexer.exited", {
        code,
        signal,
        stopping: this.stopping,
        restartCount: this.restartCount
      });
      lines.close();
      if (this.child === child) this.child = undefined;
      this.rejectPending(new Error(`索引进程已退出（${code ?? "unknown"}）`));
      if (!this.stopping && this.restartCount < 2) {
        this.restartCount += 1;
        this.updateStatus({ ...this.status, state: "error", message: "索引核心意外退出，正在重启" });
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          void this.start().catch(() => {
            // The child lifecycle handlers already publish the degraded state.
          });
        }, 1_500 * this.restartCount);
      } else if (!this.stopping) {
        this.updateStatus({
          ...this.status,
          mode: "unavailable",
          state: "error",
          message: "索引核心不可用；搜索将使用限时实时扫描"
        });
      }
    });

    const cachePath = path.join(app.getPath("userData"), "search-index-v1.bin");
    this.cachePath = cachePath;
    const contentCacheDir = path.join(app.getPath("userData"), "content-indexes");
    let forceRebuild = false;
    let rebuildReason: string | undefined;
    try {
      const cacheStats = await stat(cachePath);
      rebuildReason = determineIndexRefreshReason(
        cacheStats.mtimeMs,
        Date.now(),
        uptime()
      );
      forceRebuild = rebuildReason != null;
    } catch {
      // A missing cache is the normal first-run case; the native indexer builds it.
    }
    if (forceRebuild) {
      this.lastFullRefreshRequestedAt = Date.now();
    }
    await this.request(
      {
        op: "init",
        root: "*",
        cachePath,
        contentCacheDir,
        background: this.backgroundMode,
        forceRebuild,
        rebuildReason,
        mouseButton: this.mouseShortcutStatus.button,
        mouseHoldMs: this.mouseShortcutStatus.holdMs
      },
      90_000
    );
    if (this.backgroundMode) {
      // An indexer that starts directly in tray mode does not observe a later
      // foreground-to-background transition. Re-send the background command
      // after init so it applies the same process-tree working-set trim used
      // when a visible window is closed, without stopping watchers or search.
      await this.request(
        { op: "setBackground", background: true, processId: process.pid },
        3_000
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    logger.info("indexer.stop_started", {
      hasChild: this.child != null,
      pendingRequests: this.pending.size
    });
    this.stopPromise = (async () => {
      if (this.dailyRefreshTimer) {
        clearTimeout(this.dailyRefreshTimer);
        this.dailyRefreshTimer = undefined;
      }
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
      }
      const child = this.child;
      if (!child || child.exitCode != null) return;
      const exited = once(child, "exit").then(() => true).catch(() => true);
      try {
        await this.requestWithChild(child, { op: "quit" }, 1_500);
      } catch {
        // The process may already be closing. The exit wait and bounded kill
        // below complete shutdown without surfacing a JavaScript error dialog.
      }
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const graceful = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))
      ]);
      if (!graceful && child.exitCode == null && !child.killed) {
        logger.warn("indexer.stop_forced", { childPid: child.pid });
        child.kill();
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 500))
        ]);
      }
      if (this.child === child) this.child = undefined;
      this.rejectPending(new Error("索引服务已停止"));
      logger.info("indexer.stop_completed", { childPid: child.pid });
    })();
    return this.stopPromise;
  }

  getStatus(): IndexerStatus {
    return structuredClone(this.status);
  }

  getMouseShortcutStatus(): MouseShortcutStatus {
    return structuredClone(this.mouseShortcutStatus);
  }

  async configureMouseShortcut(
    button: MouseShortcutButton,
    holdMs: number
  ): Promise<MouseShortcutStatus> {
    this.mouseShortcutStatus = {
      ...this.mouseShortcutStatus,
      button,
      holdMs,
      message:
        button === "disabled"
          ? "鼠标快捷操作已关闭"
          : this.mouseShortcutStatus.available
            ? "全局鼠标监听可用；短按不会被拦截"
            : "鼠标监听暂不可用"
    };
    if (this.child) {
      const response = (await this.request(
        { op: "setMouseShortcut", mouseButton: button, mouseHoldMs: holdMs },
        3_000
      )) as NativeResponse & { available?: boolean };
      this.mouseShortcutStatus.available = response.available === true;
      this.mouseShortcutStatus.message =
        button === "disabled"
          ? "鼠标快捷操作已关闭"
          : response.available
            ? "全局鼠标监听可用；短按不会被拦截"
            : "Windows Raw Input 监听不可用";
    }
    return this.getMouseShortcutStatus();
  }

  setBackgroundMode(background: boolean, force = false): void {
    if (!force && this.backgroundMode === background) return;
    this.backgroundMode = background;
    if (!this.child) return;
    void this.request(
      { op: "setBackground", background, processId: process.pid },
      3_000
    ).catch(() => {
      // The process may be between a crash and its automatic restart. start()
      // includes the current mode in init, so no retry loop is needed here.
    });
  }

  async rebuild(): Promise<void> {
    if (!this.child) {
      await this.start();
      if (!this.child) throw new Error("原生索引核心不可用");
    }
    await this.request({ op: "rebuild" }, 5_000);
    this.executableCatalogCache = undefined;
  }

  async listExecutablePaths(): Promise<string[]> {
    if (
      this.executableCatalogCache &&
      Date.now() - this.executableCatalogCache.at < 10 * 60_000
    ) {
      return [...this.executableCatalogCache.paths];
    }
    if (!this.child || this.status.state === "error") return [];
    const response = await this.request(
      { op: "executableCatalog", limit: 30_000 },
      20_000
    );
    const paths = ((response.results ?? []) as SearchResult[])
      .filter((item) => !item.isDirectory && item.path.toLocaleLowerCase().endsWith(".exe"))
      .map((item) => item.path);
    this.executableCatalogCache = { at: Date.now(), paths };
    return [...paths];
  }

  async indexContent(scope: string): Promise<void> {
    if (!this.child) throw new Error("原生索引核心不可用");
    await this.request({ op: "contentIndex", scope }, 8_000);
  }

  async contentIndexStatus(scope: string): Promise<ContentIndexerStatus> {
    if (!this.child) throw new Error("原生索引核心不可用");
    const response = await this.request({ op: "contentStatus", scope }, 8_000);
    return response.status as ContentIndexerStatus;
  }

  async searchContent(
    query: string,
    scope: string,
    options: { regex?: boolean; caseSensitive?: boolean } = {}
  ): Promise<ContentSearchResult[]> {
    return (await this.searchContentPage(query, scope, options)).items;
  }

  async searchContentPage(
    query: string,
    scope: string,
    options: ContentSearchOptions & SearchPageOptions = {}
  ): Promise<SearchPage<ContentSearchResult>> {
    const limit = Math.min(2_000, Math.max(1, Math.trunc(options.limit ?? 80)));
    if (!this.child) throw new Error("原生索引核心不可用");
    const response = await this.request(
      {
        op: "contentQuery",
        query: query.trim(),
        scope,
        regex: options.regex === true,
        caseSensitive: options.caseSensitive === true,
        sortBy: options.sortBy ?? "relevance",
        sortDirection: options.sortDirection ?? "desc",
        minSize: options.minSize,
        maxSize: options.maxSize,
        modifiedAfterMs: options.modifiedAfter
          ? Date.parse(options.modifiedAfter)
          : undefined,
        modifiedBeforeMs: options.modifiedBefore
          ? Date.parse(options.modifiedBefore)
          : undefined,
        cursor: options.cursor,
        limit
      },
      options.regex ? 30_000 : 15_000
    );
    const nativeResults = (response.results ?? []) as ContentSearchResult[];
    const results = await Promise.all(
      nativeResults.map(async (result) => {
        try {
          const stats = await lstat(result.path);
          return {
            ...result,
            size: stats.isFile() ? stats.size : 0,
            modifiedAt: stats.mtime.toISOString()
          };
        } catch {
          return result;
        }
      })
    );
    return {
      items: results,
      hasMore: response.hasMore === true,
      nextCursor: response.nextCursor,
      totalMatches: response.totalMatches,
      generation: response.generation ?? 0,
      cursorReset: response.cursorReset === true
    };
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    return (await this.searchPage(query, filters)).items;
  }

  async searchPage(
    query: string,
    filters: SearchFilters,
    options: SearchPageOptions = {}
  ): Promise<SearchPage<SearchResult>> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { items: [], hasMore: false, generation: 0 };
    }
    const limit = Math.min(10_000, Math.max(1, Math.trunc(options.limit ?? 240)));
    let results: SearchResult[];
    let hasMore = false;
    let nextCursor: string | undefined;
    let totalMatches: number | undefined;
    let generation = 0;
    let cursorReset = false;
    let usingNative = false;
    if (this.child && this.status.state !== "error") {
      usingNative = true;
      const response = await this.request(
        {
          op: "query",
          query: trimmed,
          kind: filters.kind,
          scope: filters.scope || "*",
          scopes: filters.scopes?.length ? filters.scopes : [filters.scope || "*"],
          categories: filters.categories ?? [],
          extensions: filters.extensions ?? [],
          caseSensitive: filters.caseSensitive ?? false,
          wholeWord: filters.wholeWord ?? false,
          fuzzy: filters.fuzzy ?? false,
          matchPath: filters.matchPath ?? false,
          regex: filters.regex ?? false,
          sortBy: filters.sortBy ?? "relevance",
          sortDirection: filters.sortDirection ?? "desc",
          minSize: filters.minSize,
          maxSize: filters.maxSize,
          modifiedAfterMs: filters.modifiedAfter
            ? Date.parse(filters.modifiedAfter)
            : undefined,
          modifiedBeforeMs: filters.modifiedBefore
            ? Date.parse(filters.modifiedBefore)
            : undefined,
          cursor: options.cursor,
          limit
        },
        filters.regex ||
          filters.matchPath ||
          filters.sortBy === "size" ||
          filters.sortBy === "modified" ||
          filters.minSize != null ||
          filters.maxSize != null ||
          filters.modifiedAfter != null ||
          filters.modifiedBefore != null
          ? 60_000
          : 20_000
      );
      results = (response.results ?? []) as SearchResult[];
      hasMore = response.hasMore === true;
      nextCursor = response.nextCursor;
      totalMatches = response.totalMatches;
      generation = response.generation ?? 0;
      cursorReset = response.cursorReset === true;
    } else {
      results = await this.liveSearch(trimmed, filters.scope || "*", filters);
    }

    const enriched: SearchResult[] = [];
    const statConcurrency = 48;
    for (let offset = 0; offset < results.length; offset += statConcurrency) {
      const batch = results.slice(offset, offset + statConcurrency);
      const resolved = await Promise.all(
        batch.map(async (result): Promise<SearchResult | undefined> => {
          try {
            const stats = await lstat(result.path);
            return {
              ...result,
              size: stats.isFile() ? stats.size : result.size,
              modifiedAt: stats.mtime.toISOString()
            };
          } catch {
            // 缓存加载后若某项在应用关闭期间已被删除，不向用户返回失效路径。
            return undefined;
          }
        })
      );
      enriched.push(
        ...resolved.filter((item): item is SearchResult => Boolean(item))
      );
    }

    let pageItems = enriched;
    if (!usingNative) {
    const modifiedThreshold = filters.modifiedAfter
      ? new Date(filters.modifiedAfter).getTime()
      : undefined;
    const modifiedBeforeThreshold = filters.modifiedBefore
      ? new Date(filters.modifiedBefore).getTime()
      : undefined;
    const filtered = enriched.filter((item) => {
      // Directory sizes are calculated asynchronously by directorySizes().
      if (!item.isDirectory && filters.minSize != null && item.size < filters.minSize) return false;
      if (!item.isDirectory && filters.maxSize != null && item.size > filters.maxSize) return false;
      if (
        modifiedThreshold != null &&
        item.modifiedAt &&
        new Date(item.modifiedAt).getTime() < modifiedThreshold
      ) {
        return false;
      }
      if (
        modifiedBeforeThreshold != null &&
        item.modifiedAt &&
        new Date(item.modifiedAt).getTime() > modifiedBeforeThreshold
      ) {
        return false;
      }
      return true;
    });
    const direction = filters.sortDirection === "desc" ? -1 : 1;
    const sortBy = filters.sortBy ?? "relevance";
    const extension = (value: SearchResult) =>
      value.isDirectory ? "" : path.extname(value.name).toLocaleLowerCase();
    filtered.sort((first, second) => {
      let comparison = 0;
      if (sortBy === "name") {
        comparison = first.name.localeCompare(second.name, "zh-CN", {
          numeric: true,
          sensitivity: "base"
        });
      } else if (sortBy === "path") {
        comparison = first.path.localeCompare(second.path, "zh-CN", {
          numeric: true,
          sensitivity: "base"
        });
      } else if (sortBy === "size") {
        comparison = first.size - second.size;
      } else if (sortBy === "modified") {
        comparison =
          (first.modifiedAt ? new Date(first.modifiedAt).getTime() : 0) -
          (second.modifiedAt ? new Date(second.modifiedAt).getTime() : 0);
      } else if (sortBy === "type") {
        comparison = extension(first).localeCompare(extension(second));
      } else {
        comparison = second.score - first.score;
        return comparison || first.path.length - second.path.length;
      }
      return comparison * direction || first.name.localeCompare(second.name, "zh-CN");
    });
      const fallbackOffset = Number.parseInt(options.cursor?.split(":").at(-1) ?? "0", 10) || 0;
      totalMatches = filtered.length;
      pageItems = filtered.slice(fallbackOffset, fallbackOffset + limit);
      hasMore = fallbackOffset + pageItems.length < filtered.length;
      nextCursor = hasMore ? `fallback:${fallbackOffset + pageItems.length}` : undefined;
    }
    return {
      items: pageItems,
      hasMore,
      nextCursor,
      totalMatches,
      generation,
      cursorReset
    };
  }

  async directorySizes(inputPaths: string[]): Promise<DirectorySizeResult[]> {
    const normalizedTargets = new Map<
      string,
      { path: string; bytes: number; files: number; directories: number; complete: boolean }
    >();
    for (const candidate of inputPaths.slice(0, 180)) {
      const value = path.resolve(candidate);
      const key = value.toLocaleLowerCase();
      if (!normalizedTargets.has(key)) {
        normalizedTargets.set(key, {
          path: value,
          bytes: 0,
          files: 0,
          directories: 1,
          complete: true
        });
      }
    }
    if (normalizedTargets.size === 0) return [];

    const roots: string[] = [];
    for (const target of [...normalizedTargets.values()].sort(
      (first, second) => first.path.length - second.path.length
    )) {
      const lower = target.path.toLocaleLowerCase();
      if (
        !roots.some((root) => {
          const rootLower = root.toLocaleLowerCase();
          return lower === rootLower || lower.startsWith(`${rootLower}\\`);
        })
      ) {
        roots.push(target.path);
      }
    }

    const markAncestors = (
      parentPath: string,
      bytes: number,
      files: number,
      directories: number
    ) => {
      let current = path.resolve(parentPath);
      while (true) {
        const target = normalizedTargets.get(current.toLocaleLowerCase());
        if (target) {
          target.bytes += bytes;
          target.files += files;
          target.directories += directories;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };

    const deadline = Date.now() + 25_000;
    const maximumEntries = 1_000_000;
    let visited = 0;
    const scanRoot = async (root: string) => {
      const queue = [root];
      let complete = true;
      while (queue.length > 0) {
        if (Date.now() > deadline || visited >= maximumEntries) {
          complete = false;
          break;
        }
        const current = queue.shift()!;
        try {
          const directory = await opendir(current);
          for await (const entry of directory) {
            visited += 1;
            if (entry.isSymbolicLink()) continue;
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              queue.push(entryPath);
              markAncestors(current, 0, 0, 1);
              continue;
            }
            if (!entry.isFile()) continue;
            try {
              const stats = await lstat(entryPath);
              markAncestors(current, stats.size, 1, 0);
            } catch {
              complete = false;
            }
            if (Date.now() > deadline || visited >= maximumEntries) {
              complete = false;
              break;
            }
          }
        } catch {
          complete = false;
        }
      }
      if (!complete) {
        const rootLower = root.toLocaleLowerCase();
        for (const [key, target] of normalizedTargets) {
          if (key === rootLower || key.startsWith(`${rootLower}\\`)) {
            target.complete = false;
          }
        }
      }
    };

    for (let offset = 0; offset < roots.length; offset += 2) {
      await Promise.all(roots.slice(offset, offset + 2).map(scanRoot));
    }
    return [...normalizedTargets.values()];
  }

  private async liveSearch(
    query: string,
    root: string,
    filters: SearchFilters
  ): Promise<SearchResult[]> {
    const deadline = Date.now() + 2_500;
    const normalizedQuery = filters.caseSensitive ? query : query.toLocaleLowerCase();
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const expression = filters.regex
      ? new RegExp(query, filters.caseSensitive ? "u" : "iu")
      : undefined;
    const queue = root === "*" ? await getLocalDriveRoots() : [root];
    const results: SearchResult[] = [];
    while (queue.length > 0 && Date.now() < deadline && results.length < 80) {
      const current = queue.shift()!;
      try {
        const directory = await opendir(current);
        for await (const entry of directory) {
          if (entry.isSymbolicLink()) continue;
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) queue.push(entryPath);
          const kindMatches =
            filters.kind === "all" ||
            (filters.kind === "folder" && entry.isDirectory()) ||
            (filters.kind === "file" && entry.isFile());
          const originalTarget = filters.matchPath ? entryPath : entry.name;
          const target = filters.caseSensitive
            ? originalTarget
            : originalTarget.toLocaleLowerCase();
          let score: number | undefined;
          if (expression?.test(originalTarget)) {
            score = 72;
          } else if (!expression && filters.fuzzy) {
            const tokenScores = tokens.map((token) => fuzzySubsequenceScore(target, token));
            if (tokenScores.every((value) => value != null)) {
              score = tokenScores.reduce((sum, value) => sum + (value ?? 0), 0) /
                Math.max(1, tokenScores.length);
            }
          } else if (
            !expression &&
            filters.wholeWord &&
            tokens.every((token) => containsCompleteWord(target, token))
          ) {
            score = 82;
          } else if (!expression && !filters.fuzzy && !filters.wholeWord &&
            tokens.every((token) => target.includes(token))) {
            score = target === normalizedQuery ? 100 : target.startsWith(normalizedQuery) ? 92 : 70;
          }
          if (kindMatches && score != null) {
            results.push({
              path: entryPath,
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              score,
              source: "live-scan"
            });
            if (results.length >= 80) break;
          }
        }
      } catch {
        // Access-denied directories are expected during fallback scanning.
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  private request(
    payload: Record<string, unknown>,
    timeout = 10_000
  ): Promise<NativeResponse> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("索引核心未运行"));
    return this.requestWithChild(child, payload, timeout);
  }

  private requestWithChild(
    child: ChildProcessWithoutNullStreams,
    payload: Record<string, unknown>,
    timeout: number
  ): Promise<NativeResponse> {
    if (
      child.exitCode != null ||
      child.killed ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      return Promise.reject(new Error("索引通信管道已关闭"));
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn("indexer.request_timeout", {
          operation: typeof payload.op === "string" ? payload.op : "unknown",
          timeout,
          stopping: this.stopping
        });
        reject(new Error("索引请求超时"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          logger.warn("indexer.request_write_failed", {
            operation: typeof payload.op === "string" ? payload.op : "unknown",
            stopping: this.stopping,
            error: serializeError(error)
          });
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        logger.warn("indexer.request_write_threw", {
          operation: typeof payload.op === "string" ? payload.op : "unknown",
          stopping: this.stopping,
          error: serializeError(error)
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let response: NativeResponse;
    try {
      response = JSON.parse(line) as NativeResponse;
    } catch {
      return;
    }
    if (response.event === "status" && response.status) {
      this.updateStatus(response.status as IndexerStatus);
      return;
    }
    if (
      (response as NativeResponse & { event?: string; status?: ContentIndexerStatus }).event ===
        "contentStatus" &&
      (response as NativeResponse & { status?: ContentIndexerStatus }).status
    ) {
      this.onContentStatus(
        (response as NativeResponse & { status: ContentIndexerStatus }).status
      );
      return;
    }
    if (response.event === "mouseShortcutHold") {
      this.onMouseShortcutHold();
      return;
    }
    if (response.event === "indexChanged") {
      this.executableCatalogCache = undefined;
      this.onIndexChanged({
        changedCount: Math.max(1, response.changedCount ?? 1),
        observedAt: new Date().toISOString(),
        generation: response.generation,
        contentScopes: response.contentScopes
      });
      return;
    }
    if (response.event === "mouseShortcutStatus") {
      const event = response as NativeResponse & {
        available?: boolean;
        errorCode?: number;
      };
      this.mouseShortcutStatus.available = event.available === true;
      this.mouseShortcutStatus.message = event.available
        ? this.mouseShortcutStatus.button === "disabled"
          ? "鼠标快捷操作已关闭"
          : "全局鼠标监听可用；短按不会被拦截"
        : `Windows Raw Input 监听不可用${
            event.errorCode ? `（错误 ${event.errorCode}）` : ""
          }`;
      return;
    }
    if (response.id == null) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok === false) pending.reject(new Error(response.error || "索引请求失败"));
    else pending.resolve(response);
  }

  private updateStatus(status: IndexerStatus): void {
    const previousState = this.status.state;
    const previousMode = this.status.mode;
    if (status.state === "indexing" && previousState !== "indexing") {
      this.lastFullRefreshRequestedAt = Date.now();
    }
    this.status = structuredClone(status);
    if (status.state !== previousState || status.mode !== previousMode) {
      logger.info("indexer.status_changed", {
        previousState,
        previousMode,
        state: status.state,
        mode: status.mode,
        entries: status.entries,
        progress: status.progress,
        message: status.message
      });
    }
    this.onStatus(this.getStatus());
    if (status.state === "ready" && previousState !== "ready") {
      void this.scheduleDailyRefresh();
    }
  }

  private async scheduleDailyRefresh(): Promise<void> {
    if (this.dailyRefreshTimer) {
      clearTimeout(this.dailyRefreshTimer);
      this.dailyRefreshTimer = undefined;
    }
    if (this.stopping || !this.cachePath) return;

    let cacheModifiedAt = 0;
    try {
      cacheModifiedAt = (await stat(this.cachePath)).mtimeMs;
    } catch {
      // A completed scan normally creates the cache. If writing failed, retry
      // no sooner than 24 hours after the scan attempt to avoid a rebuild loop.
    }
    const refreshBase = Math.max(
      cacheModifiedAt,
      this.lastFullRefreshRequestedAt,
      Date.now() - INDEX_REFRESH_INTERVAL_MS + 1_000
    );
    const delay = Math.max(
      1_000,
      refreshBase + INDEX_REFRESH_INTERVAL_MS - Date.now()
    );
    this.dailyRefreshTimer = setTimeout(() => {
      this.dailyRefreshTimer = undefined;
      if (this.stopping) return;
      void this.rebuild().catch((error) => {
        this.updateStatus({
          ...this.status,
          state: "error",
          message: `每日自动刷新索引失败：${
            error instanceof Error ? error.message : String(error)
          }`
        });
      });
    }, delay);
  }
}
