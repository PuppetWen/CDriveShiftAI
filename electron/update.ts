import { app, net, session } from "electron";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { logger, serializeError } from "./logger";
import {
  launchUpdaterHelper,
  prepareUpdaterExecutable
} from "./update-launcher";

const RELEASE_API =
  "https://api.github.com/repos/PuppetWen/CDriveShiftAI/releases/latest";
const CACHE_DURATION_MS = 15 * 60_000;
const DOWNLOAD_RETRIES = 3;
const MANIFEST_NAME = "update-manifest.json";
const CHECK_REQUEST_TIMEOUT_MS = 20_000;
const CHECK_REQUEST_ATTEMPTS = 2;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "cancelled"
  | "error"
  | "unavailable";

export type UpdateDistribution = "installed" | "portable" | "development";

export interface AppUpdateAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface AppUpdateProgress {
  transferred: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
  retryAttempt: number;
  maxRetries: number;
}

export interface AppUpdateReleaseSection {
  title: string;
  items: string[];
}

export interface AppUpdateInfo {
  status: "checking" | "current" | "available" | "unavailable";
  phase: UpdatePhase;
  distribution: UpdateDistribution;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  releaseName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  releaseSummary?: string;
  releaseSections?: AppUpdateReleaseSection[];
  assets: AppUpdateAsset[];
  selectedAsset?: AppUpdateAsset;
  progress?: AppUpdateProgress;
  message: string;
  checkedAt: string;
  errorCode?: string;
  network?: UpdateNetworkRoute;
}

export interface UpdateNetworkRoute {
  mode: "system-proxy" | "direct" | "unavailable";
  label: string;
  resolvedAt: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{
    name?: string;
    size?: number;
    browser_download_url?: string;
  }>;
}

interface ManifestAsset {
  name: string;
  size: number;
  sha512: string;
}

interface UpdateManifest {
  schemaVersion: 1;
  version: string;
  assets: {
    installer: ManifestAsset;
    portable: ManifestAsset;
  };
}

interface UpdatePlan {
  schemaVersion: 1;
  mode: "installed" | "portable";
  parentPid: number;
  packagePath: string;
  targetPath: string;
  installedDir?: string;
  stagingDir: string;
  backupPath: string;
  successMarker: string;
  expectedVersion: string;
  expectedSha512: string;
  logPath: string;
  runnerDirectory?: string;
}

function versionParts(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/\D.*$/, ""), 10) || 0);
}

function compareVersions(first: string, second: string): number {
  const left = versionParts(first);
  const right = versionParts(second);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function cleanReleaseText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limitReleaseText(value: string, maxLength: number): string {
  const text = cleanReleaseText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function parseReleaseNotes(markdown?: string): {
  summary?: string;
  sections: AppUpdateReleaseSection[];
} {
  if (!markdown?.trim()) return { sections: [] };

  const sections: AppUpdateReleaseSection[] = [];
  const introduction: string[] = [];
  let current: AppUpdateReleaseSection | undefined;

  for (const rawLine of markdown.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) {
      const title = limitReleaseText(heading[2], 26);
      if (!title || sections.length >= 6) {
        current = undefined;
        continue;
      }
      current = { title, items: [] };
      sections.push(current);
      continue;
    }
    if (/^#\s+/.test(line)) continue;

    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    const text = limitReleaseText(bullet?.[1] ?? line, 112);
    if (!text) continue;
    if (!current) {
      if (introduction.length < 2) introduction.push(text);
      continue;
    }
    if (current.items.length < 6) current.items.push(text);
  }

  const populated = sections.filter((section) => section.items.length > 0);
  if (!populated.length && introduction.length) {
    populated.push({ title: "版本说明", items: introduction.slice(0, 4) });
  }
  return {
    summary: introduction.length
      ? limitReleaseText(introduction.join(" "), 180)
      : undefined,
    sections: populated
  };
}

function updateDistribution(): UpdateDistribution {
  if (!app.isPackaged) return "development";
  return process.env.PORTABLE_EXECUTABLE_FILE ? "portable" : "installed";
}

function distributionExecutable(): string {
  return path.resolve(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
}

function updateStagingDirectory(version: string): string {
  const executable = distributionExecutable();
  const mode = updateDistribution();
  const parent =
    mode === "installed"
      ? path.dirname(path.dirname(executable))
      : path.dirname(executable);
  return path.join(parent, ".cdriveshiftai-update", version);
}

function updateDistributionParent(): string {
  const executable = distributionExecutable();
  return updateDistribution() === "installed"
    ? path.dirname(path.dirname(executable))
    : path.dirname(executable);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function sha512(candidate: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha512");
    const stream = createReadStream(candidate);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function githubHeaders(version: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `CDriveShiftAI/${version}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

export function summarizeProxyRules(rules: string): Pick<UpdateNetworkRoute, "mode" | "label"> {
  const candidates = rules
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const proxy = candidates.find((item) => !/^DIRECT$/i.test(item));
  if (!proxy) return { mode: "direct", label: "系统网络 · 直连" };
  const match = /^(PROXY|HTTPS?|SOCKS(?:4|5)?)\s+(.+)$/i.exec(proxy);
  if (!match) return { mode: "system-proxy", label: "Windows 系统代理" };
  const endpoint = match[2].replace(/^.*@/, "");
  return {
    mode: "system-proxy",
    label: `Windows 系统代理 · ${match[1].toUpperCase()} ${endpoint}`
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function safeManifest(value: unknown): UpdateManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<UpdateManifest>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.version !== "string" ||
    !input.assets
  ) {
    return undefined;
  }
  const validAsset = (asset: ManifestAsset | undefined) =>
    asset &&
    typeof asset.name === "string" &&
    path.basename(asset.name) === asset.name &&
    !/[\u0000-\u001f]/.test(asset.name) &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    typeof asset.sha512 === "string" &&
    /^[a-f0-9]{128}$/i.test(asset.sha512);
  if (!validAsset(input.assets.installer) || !validAsset(input.assets.portable)) {
    return undefined;
  }
  return input as UpdateManifest;
}

export class UpdateService {
  private cached?: { at: number; result: AppUpdateInfo };
  private state: AppUpdateInfo;
  private manifest?: UpdateManifest;
  private abortController?: AbortController;
  private lastProgressAt = 0;
  private networkResolvedAt = 0;

  constructor(
    private readonly onState: (state: AppUpdateInfo) => void,
    private readonly canInstall: () => Promise<void>
  ) {
    const currentVersion = app.getVersion();
    this.state = {
      status: "checking",
      phase: "idle",
      distribution: updateDistribution(),
      currentVersion,
      updateAvailable: false,
      canAutoUpdate: false,
      assets: [],
      message: "尚未检查更新",
      checkedAt: new Date(0).toISOString()
    };
  }

  getState(): AppUpdateInfo {
    return clone(this.state);
  }

  private setState(patch: Partial<AppUpdateInfo>): AppUpdateInfo {
    this.state = { ...this.state, ...patch };
    const result = this.getState();
    this.onState(result);
    return result;
  }

  private async resolveNetworkRoute(url: string, force = false): Promise<void> {
    if (!force && this.state.network && Date.now() - this.networkResolvedAt < 30_000) {
      return;
    }
    const resolvedAt = new Date().toISOString();
    try {
      const rules = await session.defaultSession.resolveProxy(url);
      const summary = summarizeProxyRules(rules);
      this.networkResolvedAt = Date.now();
      this.setState({ network: { ...summary, resolvedAt } });
      logger.info("update.network_route", summary);
    } catch (error) {
      this.networkResolvedAt = Date.now();
      this.setState({
        network: {
          mode: "unavailable",
          label: "系统代理检测失败，按 Windows 默认网络继续",
          resolvedAt
        }
      });
      logger.warn("update.proxy_resolution_failed", { error: serializeError(error) });
    }
  }

  private async networkFetch(
    url: string,
    init: Parameters<typeof net.fetch>[1],
    refreshRoute = false
  ): Promise<Response> {
    await this.resolveNetworkRoute(url, refreshRoute);
    return net.fetch(url, init);
  }

  private async fetchForUpdateCheck(
    url: string,
    currentVersion: string,
    refreshRoute = false
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHECK_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.networkFetch(
          url,
          {
            headers: githubHeaders(currentVersion),
            signal: AbortSignal.timeout(CHECK_REQUEST_TIMEOUT_MS)
          },
          refreshRoute && attempt === 1
        );
        if (
          attempt < CHECK_REQUEST_ATTEMPTS &&
          (response.status === 408 || response.status === 429 || response.status >= 500)
        ) {
          await delay(450 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        logger.warn("update.check_attempt_failed", {
          attempt,
          maxAttempts: CHECK_REQUEST_ATTEMPTS,
          url: new URL(url).origin,
          error: serializeError(error)
        });
        if (attempt < CHECK_REQUEST_ATTEMPTS) await delay(450 * attempt);
      }
    }
    const timedOut =
      lastError instanceof Error &&
      (lastError.name === "TimeoutError" || /timeout|timed out/i.test(lastError.message));
    throw new Error(
      timedOut
        ? `连接 GitHub 超时（已重试 ${CHECK_REQUEST_ATTEMPTS} 次），请检查系统代理后重试`
        : `连接 GitHub 失败（已重试 ${CHECK_REQUEST_ATTEMPTS} 次）：${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`
    );
  }

  async check(force = false): Promise<AppUpdateInfo> {
    const now = Date.now();
    if (!force && this.cached && now - this.cached.at < CACHE_DURATION_MS) {
      this.state = clone(this.cached.result);
      return this.getState();
    }

    const currentVersion = app.getVersion();
    const checkedAt = new Date().toISOString();
    this.setState({
      status: "checking",
      phase: "checking",
      message: "正在检查 GitHub Release…",
      errorCode: undefined
    });
    try {
      const response = await this.fetchForUpdateCheck(
        RELEASE_API,
        currentVersion,
        true
      );
      if (!response.ok) {
        throw new Error(`GitHub Release 返回 HTTP ${response.status}`);
      }
      const release = (await response.json()) as GitHubRelease;
      if (release.draft || release.prerelease || !release.tag_name) {
        throw new Error("尚未找到可用的正式版本");
      }
      const assets = (release.assets ?? [])
        .filter(
          (asset) =>
            typeof asset.name === "string" &&
            typeof asset.browser_download_url === "string"
        )
        .map((asset) => ({
          name: asset.name!,
          size: Number(asset.size) || 0,
          downloadUrl: asset.browser_download_url!
        }));
      const latestVersion = release.tag_name.replace(/^v/i, "");
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latestVersion)) {
        throw new Error("Release 版本号格式无效");
      }
      const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
      const manifestReleaseAsset = assets.find(
        (asset) => asset.name.toLocaleLowerCase() === MANIFEST_NAME
      );
      let manifest: UpdateManifest | undefined;
      if (updateAvailable && manifestReleaseAsset) {
        try {
          const manifestResponse = await this.fetchForUpdateCheck(
            manifestReleaseAsset.downloadUrl,
            currentVersion
          );
          if (manifestResponse.ok) {
            manifest = safeManifest(await manifestResponse.json());
          }
        } catch (error) {
          logger.warn("update.manifest_fetch_failed", {
            error: serializeError(error)
          });
        }
      }
      if (manifest && manifest.version !== latestVersion) manifest = undefined;
      const distribution = updateDistribution();
      const manifestAsset =
        distribution === "portable"
          ? manifest?.assets.portable
          : manifest?.assets.installer;
      const selectedAsset = manifestAsset
        ? assets.find((asset) => asset.name === manifestAsset.name)
        : undefined;
      const canAutoUpdate =
        updateAvailable &&
        app.isPackaged &&
        distribution !== "development" &&
        Boolean(manifest && manifestAsset && selectedAsset);
      this.manifest = manifest;
      const releaseNotes = parseReleaseNotes(release.body);
      const result: AppUpdateInfo = {
        status: updateAvailable ? "available" : "current",
        phase: updateAvailable ? "available" : "current",
        distribution,
        currentVersion,
        latestVersion,
        updateAvailable,
        canAutoUpdate,
        releaseName: release.name || `CDriveShiftAI ${latestVersion}`,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        releaseSummary: releaseNotes.summary,
        releaseSections: releaseNotes.sections,
        assets,
        selectedAsset,
        message: updateAvailable
          ? canAutoUpdate
            ? `发现新版本 ${latestVersion}，可自动下载并更新`
            : `发现新版本 ${latestVersion}，但该 Release 缺少自动更新清单`
          : `当前已是最新版本 ${currentVersion}`,
        checkedAt,
        network: this.state.network
      };
      this.state = result;
      this.cached = { at: now, result: clone(result) };
      this.onState(this.getState());
      return this.getState();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const knownUpdate = Boolean(
        this.state.latestVersion &&
          compareVersions(this.state.latestVersion, currentVersion) > 0
      );
      return this.setState({
        status: "unavailable",
        phase: "unavailable",
        currentVersion,
        updateAvailable: knownUpdate,
        canAutoUpdate: knownUpdate && this.state.canAutoUpdate,
        assets: knownUpdate ? this.state.assets : [],
        selectedAsset: knownUpdate ? this.state.selectedAsset : undefined,
        progress: undefined,
        message: knownUpdate
          ? `已知新版本 ${this.state.latestVersion}；本次联网复查失败：${errorMessage}`
          : `暂时无法检查更新：${errorMessage}`,
        checkedAt,
        errorCode: /超时/.test(errorMessage) ? "CHECK_TIMEOUT" : "CHECK_FAILED"
      });
    }
  }

  cancel(): AppUpdateInfo {
    this.abortController?.abort(new Error("用户已取消下载"));
    return this.setState({
      phase: "cancelled",
      message: "已暂停更新；下次继续时会从已下载位置续传",
      errorCode: undefined
    });
  }

  async downloadAndInstall(): Promise<AppUpdateInfo> {
    try {
      return await this.performDownloadAndInstall();
    } catch (error) {
      logger.error("update.failed", {
        phase: this.state.phase,
        distribution: this.state.distribution,
        version: this.state.latestVersion,
        error: serializeError(error)
      });
      if (this.abortController?.signal.aborted) {
        return this.setState({
          phase: "cancelled",
          message: "已暂停更新；下次继续时会从已下载位置续传",
          errorCode: undefined
        });
      }
      return this.setState({
        phase: "error",
        message: `自动更新未完成：${
          error instanceof Error ? error.message : String(error)
        }`,
        errorCode: "UPDATE_FAILED"
      });
    } finally {
      this.abortController = undefined;
    }
  }

  private async performDownloadAndInstall(): Promise<AppUpdateInfo> {
    if (this.state.phase === "downloading" || this.state.phase === "verifying") {
      return this.getState();
    }
    if (!this.state.updateAvailable || !this.state.canAutoUpdate) {
      const checked = await this.check(true);
      if (!checked.updateAvailable || !checked.canAutoUpdate) return checked;
    }
    await this.canInstall();
    const distribution = updateDistribution();
    const manifestAsset =
      distribution === "portable"
        ? this.manifest?.assets.portable
        : this.manifest?.assets.installer;
    const selectedAsset = this.state.selectedAsset;
    const latestVersion = this.state.latestVersion;
    if (!manifestAsset || !selectedAsset || !latestVersion) {
      throw new Error("Release 自动更新资产不完整");
    }
    const controller = new AbortController();
    this.abortController = controller;
    const stagingDir = updateStagingDirectory(latestVersion);
    await mkdir(stagingDir, { recursive: true });
    const partialPath = path.join(stagingDir, `${manifestAsset.name}.part`);
    const packagePath = path.join(stagingDir, manifestAsset.name);
    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
      try {
        await this.downloadAttempt(
          selectedAsset.downloadUrl,
          partialPath,
          manifestAsset.size,
          attempt,
          controller.signal
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) throw error;
        if (attempt < DOWNLOAD_RETRIES) {
          this.setState({
            phase: "downloading",
            message: `下载中断，${Math.min(2 ** (attempt - 1), 4)} 秒后进行第 ${
              attempt + 1
            } 次尝试…`
          });
          await delay(Math.min(2 ** (attempt - 1), 4) * 1_000, controller.signal);
        }
      }
    }
    if (lastError) {
      return this.setState({
        phase: "error",
        message: `更新包下载失败：${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        errorCode: "DOWNLOAD_FAILED"
      });
    }

    this.setState({
      phase: "verifying",
      message: "正在校验更新包完整性与 SHA-512…",
      progress: {
        transferred: manifestAsset.size,
        total: manifestAsset.size,
        percent: 100,
        bytesPerSecond: 0,
        retryAttempt: this.state.progress?.retryAttempt ?? 1,
        maxRetries: DOWNLOAD_RETRIES
      }
    });
    const partialStats = await stat(partialPath);
    const actualDigest = await sha512(partialPath);
    if (
      partialStats.size !== manifestAsset.size ||
      actualDigest.toLocaleLowerCase() !== manifestAsset.sha512.toLocaleLowerCase()
    ) {
      await rm(partialPath, { force: true });
      return this.setState({
        phase: "error",
        message: "更新包校验失败，已拒绝安装并删除损坏文件",
        errorCode: "CHECKSUM_MISMATCH"
      });
    }
    await rm(packagePath, { force: true });
    await rename(partialPath, packagePath);
    this.setState({
      phase: "ready",
      message: "更新包校验通过，正在准备安全替换…",
      errorCode: undefined
    });
    return this.install(packagePath, manifestAsset);
  }

  private async downloadAttempt(
    url: string,
    partialPath: string,
    total: number,
    attempt: number,
    signal: AbortSignal
  ): Promise<void> {
    let transferred = 0;
    if (await exists(partialPath)) {
      transferred = (await stat(partialPath)).size;
      if (transferred > total) {
        await rm(partialPath, { force: true });
        transferred = 0;
      }
    }
    const headers: Record<string, string> = githubHeaders(app.getVersion());
    if (transferred > 0) headers.Range = `bytes=${transferred}-`;
    const response = await this.networkFetch(
      url,
      { headers, signal, redirect: "follow" },
      attempt === 1
    );
    if (response.status === 416 && transferred === total) return;
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (transferred > 0 && response.status !== 206) {
      await rm(partialPath, { force: true });
      transferred = 0;
    }
    if (!response.body) throw new Error("下载响应没有数据流");
    const file = await open(partialPath, transferred > 0 ? "a" : "w");
    const reader = response.body.getReader();
    const startedAt = Date.now();
    const startedBytes = transferred;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw signal.reason;
        await file.write(value);
        transferred += value.byteLength;
        const now = Date.now();
        if (now - this.lastProgressAt >= 120 || transferred >= total) {
          this.lastProgressAt = now;
          const elapsed = Math.max(0.25, (now - startedAt) / 1_000);
          this.setState({
            phase: "downloading",
            message:
              attempt > 1
                ? `正在断点续传（第 ${attempt}/${DOWNLOAD_RETRIES} 次尝试）`
                : "正在下载更新包…",
            progress: {
              transferred,
              total,
              percent: Math.min(100, (transferred / total) * 100),
              bytesPerSecond: Math.max(0, (transferred - startedBytes) / elapsed),
              retryAttempt: attempt,
              maxRetries: DOWNLOAD_RETRIES
            },
            errorCode: undefined
          });
        }
      }
    } finally {
      await file.close();
    }
    if (transferred !== total) {
      throw new Error(`文件大小不完整（${transferred}/${total} 字节）`);
    }
  }

  private async install(
    packagePath: string,
    manifestAsset: ManifestAsset
  ): Promise<AppUpdateInfo> {
    await this.canInstall();
    const distribution = updateDistribution();
    if (distribution === "development") {
      throw new Error("开发模式不能执行自更新");
    }
    const targetPath = distributionExecutable();
    const stagingDir = path.dirname(packagePath);
    const helperSource = path.join(
      process.resourcesPath,
      "bin",
      "cshift-updater.exe"
    );
    if (!(await exists(helperSource))) {
      throw new Error("更新助手缺失，已保留下载包但不会执行替换");
    }
    const helperPath = path.join(stagingDir, "cshift-updater.exe");
    const runnerDirectory = path.join(
      updateDistributionParent(),
      "CDriveShiftAI-Update-Runner",
      this.state.latestVersion!
    );
    let fallbackHelperPath = path.join(
      runnerDirectory,
      "CDriveShiftAI-Update.exe"
    );
    await prepareUpdaterExecutable(helperSource, helperPath);
    try {
      await prepareUpdaterExecutable(helperSource, fallbackHelperPath);
    } catch (error) {
      logger.warn("update.fallback_helper_prepare_failed", {
        fallbackHelperPath,
        error: serializeError(error)
      });
      // Never execute a fallback copy that did not pass byte-for-byte hashing.
      // PowerShell can still provide a separate launch API for the verified
      // primary helper if this directory itself could not be created.
      fallbackHelperPath = helperPath;
    }
    const plan: UpdatePlan = {
      schemaVersion: 1,
      mode: distribution,
      parentPid: process.pid,
      packagePath,
      targetPath:
        distribution === "installed"
          ? path.join(path.dirname(targetPath), "CDriveShiftAI.exe")
          : targetPath,
      installedDir: distribution === "installed" ? path.dirname(targetPath) : undefined,
      stagingDir,
      backupPath: path.join(
        stagingDir,
        distribution === "installed" ? "previous-version" : "previous-version.exe"
      ),
      successMarker: path.join(stagingDir, "update-success.json"),
      expectedVersion: this.state.latestVersion!,
      expectedSha512: manifestAsset.sha512,
      logPath: path.join(stagingDir, "update.log"),
      runnerDirectory
    };
    const planPath = path.join(stagingDir, "update-plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    this.setState({
      phase: "installing",
      message:
        distribution === "installed"
          ? "即将退出并静默安装；失败时会自动恢复旧版本"
          : "即将退出并在原路径替换便携版；失败时会自动恢复旧文件"
    });
    const launched = await launchUpdaterHelper({
      primaryPath: helperPath,
      fallbackPath: fallbackHelperPath,
      planPath,
      forcePrimaryFailure:
        process.env.CDRIVESHIFTAI_UPDATE_FORCE_PRIMARY_EACCES === "1"
    });
    logger.info("update.install_handoff", {
      distribution,
      version: this.state.latestVersion,
      strategy: launched.strategy,
      executable: launched.executable,
      childPid: launched.child.pid
    });
    setTimeout(() => app.quit(), 180);
    return this.getState();
  }
}

function safeUpdateStaging(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved
    .split(path.sep)
    .some((segment) => segment.toLocaleLowerCase() === ".cdriveshiftai-update");
}

function safeUpdateRunner(candidate: string): boolean {
  return path
    .resolve(candidate)
    .split(path.sep)
    .some(
      (segment) =>
        segment.toLocaleLowerCase() === "cdriveshiftai-update-runner"
    );
}

export async function completePendingUpdate(): Promise<void> {
  const markerIndex = process.argv.indexOf("--update-staging");
  if (markerIndex < 0) return;
  const stagingDir = process.argv[markerIndex + 1];
  if (!stagingDir || !safeUpdateStaging(stagingDir)) return;
  try {
    const plan = JSON.parse(
      await readFile(path.join(stagingDir, "update-plan.json"), "utf8")
    ) as UpdatePlan;
    if (
      plan.schemaVersion !== 1 ||
      path.resolve(plan.stagingDir) !== path.resolve(stagingDir) ||
      plan.expectedVersion !== app.getVersion()
    ) {
      return;
    }
    await writeFile(
      plan.successMarker,
      JSON.stringify({
        version: app.getVersion(),
        startedAt: new Date().toISOString(),
        pid: process.pid
      }),
      "utf8"
    );
    const cleanup = async (remaining = 20): Promise<void> => {
      try {
        await rm(stagingDir, { recursive: true, force: true });
        if (plan.runnerDirectory && safeUpdateRunner(plan.runnerDirectory)) {
          await rm(plan.runnerDirectory, { recursive: true, force: true });
        }
      } catch {
        if (remaining > 0) {
          setTimeout(() => void cleanup(remaining - 1), 1_500);
        }
      }
    };
    setTimeout(() => void cleanup(), 3_000);
  } catch {
    // The helper treats a missing success marker as a failed update and
    // restores the previous executable/application directory.
  }
}
