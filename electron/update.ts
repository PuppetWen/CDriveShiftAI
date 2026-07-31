import { app } from "electron";

const RELEASE_API =
  "https://api.github.com/repos/PuppetWen/CDriveShiftAI/releases/latest";
const CACHE_DURATION_MS = 15 * 60_000;

export interface AppUpdateAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface AppUpdateInfo {
  status: "current" | "available" | "unavailable";
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  assets: AppUpdateAsset[];
  message: string;
  checkedAt: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{
    name?: string;
    size?: number;
    browser_download_url?: string;
  }>;
}

let cached: { at: number; result: AppUpdateInfo } | undefined;

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

export async function checkForUpdates(force = false): Promise<AppUpdateInfo> {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_DURATION_MS) {
    return structuredClone(cached.result);
  }

  const currentVersion = app.getVersion();
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `CDriveShiftAI/${currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) {
      throw new Error(`GitHub Release 返回 HTTP ${response.status}`);
    }
    const release = (await response.json()) as GitHubRelease;
    if (release.draft || release.prerelease || !release.tag_name) {
      throw new Error("尚未找到可用的正式版本");
    }
    const latestVersion = release.tag_name.replace(/^v/i, "");
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
    const result: AppUpdateInfo = {
      status: updateAvailable ? "available" : "current",
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseName: release.name || `CDriveShiftAI ${latestVersion}`,
      releaseUrl: release.html_url,
      publishedAt: release.published_at,
      assets: (release.assets ?? [])
        .filter(
          (asset) =>
            typeof asset.name === "string" &&
            typeof asset.browser_download_url === "string"
        )
        .map((asset) => ({
          name: asset.name!,
          size: Number(asset.size) || 0,
          downloadUrl: asset.browser_download_url!
        })),
      message: updateAvailable
        ? `发现新版本 ${latestVersion}`
        : `当前已是最新版本 ${currentVersion}`,
      checkedAt
    };
    cached = { at: now, result };
    return structuredClone(result);
  } catch (error) {
    return {
      status: "unavailable",
      currentVersion,
      updateAvailable: false,
      assets: [],
      message: `暂时无法检查更新：${
        error instanceof Error ? error.message : String(error)
      }`,
      checkedAt
    };
  }
}
