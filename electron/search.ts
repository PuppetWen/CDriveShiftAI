import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { access, lstat, opendir, stat } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import type {
  ContentIndexerStatus,
  ContentSearchResult,
  DirectorySizeResult,
  IndexerStatus,
  NativeResponse,
  SearchFilters,
  SearchResult
} from "./types";
import { getLocalDriveRoots } from "./system";
import {
  determineIndexRefreshReason,
  INDEX_REFRESH_INTERVAL_MS
} from "./index-refresh-policy";

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
  private lastFullRefreshRequestedAt = 0;
  private backgroundMode = false;

  constructor(
    private readonly onStatus: (status: IndexerStatus) => void,
    private readonly onContentStatus: (status: ContentIndexerStatus) => void
  ) {}

  async start(): Promise<void> {
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

    this.child = spawn(executable, ["--serve"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.status.message = message.slice(-300);
    });
    this.child.on("exit", (code) => {
      this.child = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`索引进程已退出（${code ?? "unknown"}）`));
      }
      this.pending.clear();
      if (!this.stopping && this.restartCount < 2) {
        this.restartCount += 1;
        this.updateStatus({ ...this.status, state: "error", message: "索引核心意外退出，正在重启" });
        setTimeout(() => void this.start(), 1_500 * this.restartCount);
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
        rebuildReason
      },
      90_000
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.dailyRefreshTimer) {
      clearTimeout(this.dailyRefreshTimer);
      this.dailyRefreshTimer = undefined;
    }
    if (!this.child) return;
    try {
      await this.request({ op: "quit" }, 2_000);
    } catch {
      this.child.kill();
    }
  }

  getStatus(): IndexerStatus {
    return structuredClone(this.status);
  }

  setBackgroundMode(background: boolean): void {
    if (this.backgroundMode === background) return;
    this.backgroundMode = background;
    if (!this.child) return;
    void this.request({ op: "setBackground", background }, 3_000).catch(() => {
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
    if (!this.child) throw new Error("原生索引核心不可用");
    const response = await this.request(
      {
        op: "contentQuery",
        query: query.trim(),
        scope,
        regex: options.regex === true,
        caseSensitive: options.caseSensitive === true,
        limit: 160
      },
      options.regex ? 30_000 : 15_000
    );
    const results = (response.results ?? []) as ContentSearchResult[];
    return Promise.all(
      results.map(async (result) => {
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
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    let results: SearchResult[];
    if (this.child && this.status.state !== "error") {
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
          matchPath: filters.matchPath ?? false,
          regex: filters.regex ?? false,
          limit: 800
        },
        filters.regex || filters.matchPath ? 20_000 : 8_000
      );
      results = (response.results ?? []) as SearchResult[];
    } else {
      results = await this.liveSearch(trimmed, filters.scope || "*", filters.kind);
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
    return filtered.slice(0, 500);
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
    kind: SearchFilters["kind"]
  ): Promise<SearchResult[]> {
    const deadline = Date.now() + 2_500;
    const normalizedQuery = query.toLocaleLowerCase();
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
            kind === "all" ||
            (kind === "folder" && entry.isDirectory()) ||
            (kind === "file" && entry.isFile());
          if (kindMatches && entry.name.toLocaleLowerCase().includes(normalizedQuery)) {
            results.push({
              path: entryPath,
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              score: entry.name.toLocaleLowerCase() === normalizedQuery ? 100 : 70,
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
    if (!this.child) return Promise.reject(new Error("索引核心未运行"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("索引请求超时"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
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
    if (status.state === "indexing" && previousState !== "indexing") {
      this.lastFullRefreshRequestedAt = Date.now();
    }
    this.status = structuredClone(status);
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
