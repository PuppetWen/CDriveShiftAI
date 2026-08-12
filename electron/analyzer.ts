import { execFile } from "node:child_process";
import { lstat, opendir, readdir, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AnalysisResult,
  DirectoryInsight,
  DirectorySummary,
  InstalledApplication,
  OwnershipMapEntry,
  OwnershipMapResult,
  OwnershipCandidate
} from "./types";
import {
  inferKnownDirectory,
  recommendationForInsight
} from "./directory-knowledge";
import {
  getLocalDriveRoots,
  isHighRiskApplicationPath,
  normalizeWindowsPath,
  protectedReason,
  samePath
} from "./system";

const execFileAsync = promisify(execFile);
const MAX_ANALYSIS_ENTRIES = 1_000_000;

interface ChildAggregate {
  path: string;
  bytes: number;
  isDirectory: boolean;
}

function extensionOf(name: string): string {
  const extension = path.extname(name).toLocaleLowerCase();
  return extension || "(无扩展名)";
}

function firstChild(root: string, itemPath: string): string {
  const relative = path.relative(root, itemPath);
  const first = relative.split(path.sep)[0];
  return path.join(root, first);
}

export async function summarizeDirectory(
  inputPath: string,
  options: { includeReparsePoints?: boolean } = {}
): Promise<DirectorySummary> {
  const root = normalizeWindowsPath(inputPath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("所选路径不是目录");
  if (rootStat.isSymbolicLink()) throw new Error("不能分析已是符号链接的目录");

  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 1;
  let reparsePointCount = 0;
  let newestMtime = rootStat.mtimeMs;
  const extensionMap = new Map<string, { count: number; bytes: number }>();
  const childMap = new Map<string, ChildAggregate>();
  const sampleNames: string[] = [];
  const scanErrors: string[] = [];
  const reparsePoints: Array<{ relativePath: string; target: string }> = [];
  const queue = [root];
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    let directory;
    try {
      directory = await opendir(current);
    } catch (error) {
      if (scanErrors.length < 20) {
        scanErrors.push(`${current}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    for await (const entry of directory) {
      processed += 1;
      if (processed > MAX_ANALYSIS_ENTRIES) {
        scanErrors.push(`目录超过 ${MAX_ANALYSIS_ENTRIES.toLocaleString()} 个条目，分析已截断`);
        queue.length = 0;
        break;
      }

      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        reparsePointCount += 1;
        if (options.includeReparsePoints) {
          try {
            reparsePoints.push({
              relativePath: path.relative(root, entryPath),
              target: await readlink(entryPath)
            });
          } catch (error) {
            if (scanErrors.length < 20) {
              scanErrors.push(`${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        continue;
      }

      let stats;
      try {
        stats = await lstat(entryPath);
      } catch (error) {
        if (scanErrors.length < 20) {
          scanErrors.push(`${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      newestMtime = Math.max(newestMtime, stats.mtimeMs);
      const childPath = firstChild(root, entryPath);
      const aggregate = childMap.get(childPath) ?? {
        path: childPath,
        bytes: 0,
        isDirectory: entryPath === childPath ? stats.isDirectory() : true
      };

      if (stats.isDirectory()) {
        directoryCount += 1;
        queue.push(entryPath);
        if (sampleNames.length < 24 && current === root) sampleNames.push(entry.name);
      } else if (stats.isFile()) {
        const bytes = stats.size;
        fileCount += 1;
        totalBytes += bytes;
        aggregate.bytes += bytes;
        const extension = extensionOf(entry.name);
        const bucket = extensionMap.get(extension) ?? { count: 0, bytes: 0 };
        bucket.count += 1;
        bucket.bytes += bytes;
        extensionMap.set(extension, bucket);
        if (sampleNames.length < 24 && (current === root || fileCount % 101 === 0)) {
          sampleNames.push(entry.name);
        }
      }
      childMap.set(childPath, aggregate);
    }
  }

  const extensionBreakdown = [...extensionMap]
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 16);
  const largestChildren = [...childMap.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 16);

  return {
    path: root,
    totalBytes,
    fileCount,
    directoryCount,
    reparsePointCount,
    ...(options.includeReparsePoints ? { reparsePoints } : {}),
    lastModified: new Date(newestMtime).toISOString(),
    extensionBreakdown,
    largestChildren,
    sampleNames,
    scanErrors
  };
}

let applicationCache: { at: number; apps: InstalledApplication[] } | undefined;

export async function listInstalledApplications(): Promise<InstalledApplication[]> {
  if (applicationCache && Date.now() - applicationCache.at < 5 * 60_000) {
    return applicationCache.apps;
  }
  const script = `
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$registryPaths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$registry = Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName } |
  ForEach-Object {
    [PSCustomObject]@{
      name = [string]$_.DisplayName
      publisher = [string]$_.Publisher
      installLocation = [string]$_.InstallLocation
      displayIcon = [string]$_.DisplayIcon
      executablePath = ''
      source = 'registry'
    }
  }
$packages = Get-AppxPackage -ErrorAction SilentlyContinue |
  ForEach-Object {
    [PSCustomObject]@{
      name = [string]$_.Name
      publisher = [string]$_.Publisher
      installLocation = [string]$_.InstallLocation
      displayIcon = ''
      executablePath = ''
      source = 'appx'
    }
  }
$appPathRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\*'
)
$appPaths = Get-Item -Path $appPathRoots -ErrorAction SilentlyContinue |
  ForEach-Object {
    try {
      $target = ([string]$_.GetValue('')).Trim('"')
      if ($target -and $target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        [PSCustomObject]@{
          name = [IO.Path]::GetFileNameWithoutExtension($target)
          publisher = ''
          installLocation = [IO.Path]::GetDirectoryName($target)
          displayIcon = $target
          executablePath = $target
          source = 'app-path'
        }
      }
    } catch {}
  }
@($registry) + @($packages) + @($appPaths) | ConvertTo-Json -Compress -Depth 4
`;
  let parsed: InstalledApplication[] = [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 20_000
      }
    );
    const value = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as
      | InstalledApplication
      | InstalledApplication[];
    parsed = Array.isArray(value) ? value : [value];
  } catch {
    parsed = [];
  }
  try {
    const appPathsScript = `
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*'
)
$items = foreach ($key in @(Get-Item -Path $roots -ErrorAction SilentlyContinue)) {
  try {
    $target = ([string]$key.GetValue('')).Trim('"')
    if ($target -and $target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
      [PSCustomObject]@{
        name = [IO.Path]::GetFileNameWithoutExtension($target)
        publisher = ''
        installLocation = [IO.Path]::GetDirectoryName($target)
        displayIcon = $target
        executablePath = $target
        source = 'app-path'
      }
    }
  } catch {}
}
@($items) | ConvertTo-Json -Compress -Depth 3
`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", appPathsScript],
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 8_000
      }
    );
    const value = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as
      | InstalledApplication
      | InstalledApplication[];
    parsed.push(...(Array.isArray(value) ? value : value ? [value] : []));
  } catch {
    // App Paths is an additional evidence source; registry/AppX discovery remains usable.
  }
  const deduplicated = new Map<string, InstalledApplication>();
  for (const app of parsed) {
    if (!app?.name?.trim()) continue;
    app.publisher ||= undefined;
    app.installLocation ||= undefined;
    app.displayIcon ||= undefined;
    app.executablePath ||= undefined;
    const key = `${app.name}|${app.installLocation ?? ""}`.toLocaleLowerCase();
    deduplicated.set(key, app);
  }
  const apps = [...deduplicated.values()];
  applicationCache = { at: Date.now(), apps };
  return apps;
}

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

const GENERIC_OWNERSHIP_TOKENS = new Set([
  "app",
  "application",
  "applications",
  "client",
  "data",
  "desktop",
  "helper",
  "installer",
  "local",
  "microsoft",
  "program",
  "programs",
  "roaming",
  "server",
  "service",
  "setup",
  "software",
  "system",
  "tool",
  "tools",
  "update",
  "updater",
  "users",
  "windows",
  "x64",
  "x86",
  "助手",
  "工具",
  "应用",
  "客户端"
]);

function ownershipTokens(value: string): string[] {
  return tokens(value).filter((token) => !GENERIC_OWNERSHIP_TOKENS.has(token));
}

function compactIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

interface PreparedApplication {
  app: InstalledApplication;
  nameTokens: string[];
  publisherTokens: string[];
  compactName: string;
  normalizedInstallLocation?: string;
}

function prepareApplication(app: InstalledApplication): PreparedApplication {
  let normalizedInstallLocation: string | undefined;
  if (app.installLocation) {
    try {
      normalizedInstallLocation = normalizeWindowsPath(app.installLocation).toLocaleLowerCase();
    } catch {
      // Some uninstall records contain a command line instead of a directory.
    }
  }
  return {
    app,
    nameTokens: ownershipTokens(app.name),
    publisherTokens: ownershipTokens(app.publisher ?? ""),
    compactName: compactIdentity(app.name),
    normalizedInstallLocation
  };
}

function pathsOverlapFast(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}\\`) ||
    second.startsWith(`${first}\\`)
  );
}

function candidateScorePrepared(
  normalizedRoot: string,
  pathTokens: Set<string>,
  prepared: PreparedApplication
): OwnershipCandidate | undefined {
  const { app } = prepared;
  const evidence: string[] = [];
  let score = 0;
  if (
    app.installLocation &&
    prepared.normalizedInstallLocation &&
    pathsOverlapFast(normalizedRoot, prepared.normalizedInstallLocation)
  ) {
    score += 0.72;
    evidence.push(`路径与安装位置重合：${app.installLocation}`);
  }

  const rootName = path.win32.basename(normalizedRoot);
  const compactRoot = compactIdentity(rootName);
  const compactMatches =
    compactRoot.length >= 3 &&
    (prepared.compactName === compactRoot ||
      (compactRoot.length >= 5 &&
        (prepared.compactName.includes(compactRoot) ||
          compactRoot.includes(prepared.compactName))));
  if (compactMatches) {
    score += prepared.compactName === compactRoot ? 0.56 : 0.42;
    evidence.push(`目录名与应用名高度一致：${rootName}`);
  }

  const overlaps = prepared.nameTokens.filter((token) => pathTokens.has(token));
  const distinctiveOverlaps = overlaps.filter((token) => token.length >= 4);
  if (!compactMatches && (distinctiveOverlaps.length > 0 || overlaps.length >= 2)) {
    score += Math.min(0.4, 0.2 + distinctiveOverlaps.length * 0.1 + overlaps.length * 0.04);
    evidence.push(`应用名称特征匹配：${overlaps.join("、")}`);
  }

  if (score >= 0.28) {
    const publisherOverlap = prepared.publisherTokens.find(
      (token) => token.length >= 4 && pathTokens.has(token)
    );
    if (publisherOverlap) {
      score += 0.08;
      evidence.push(`发布者特征匹配：${publisherOverlap}`);
    }
  }

  if (score < 0.28) return undefined;
  if (app.source === "registry") evidence.push("来源：Windows 卸载注册表");
  if (app.source === "appx") evidence.push("来源：Windows AppX 包清单");
  if (app.source === "app-path") evidence.push("来源：Windows App Paths");
  return {
    appName: app.name,
    publisher: app.publisher,
    installLocation: app.installLocation,
    confidence: Math.min(0.98, score),
    reason: evidence[0] ?? "目录名称与已安装应用记录相似",
    evidence
  };
}

function candidateScore(root: string, app: InstalledApplication): OwnershipCandidate | undefined {
  const normalizedRoot = normalizeWindowsPath(root).toLocaleLowerCase();
  const rootName = path.win32.basename(normalizedRoot);
  return candidateScorePrepared(
    normalizedRoot,
    new Set(ownershipTokens(rootName)),
    prepareApplication(app)
  );
}

const GENERIC_EXECUTABLE_NAMES = new Set([
  "app",
  "application",
  "client",
  "crashpad_handler",
  "helper",
  "installer",
  "launcher",
  "service",
  "setup",
  "unins000",
  "uninstall",
  "update",
  "updater"
]);

interface PortablePathIndex {
  fingerprint: string;
  byToken: Map<string, string[]>;
  byCompact: Map<string, string[]>;
  byParent: Map<string, string[]>;
}

let portablePathIndexCache: PortablePathIndex | undefined;

function appendPortableIndex(map: Map<string, string[]>, key: string, value: string): void {
  if (!key) return;
  const items = map.get(key);
  if (items) {
    if (items.length < 80) items.push(value);
  } else {
    map.set(key, [value]);
  }
}

function portablePathIndex(executablePaths: string[]): PortablePathIndex {
  const values = executablePaths.slice(0, 30_000);
  const fingerprint = `${values.length}|${values[0] ?? ""}|${values.at(-1) ?? ""}`;
  if (portablePathIndexCache?.fingerprint === fingerprint) return portablePathIndexCache;
  const index: PortablePathIndex = {
    fingerprint,
    byToken: new Map(),
    byCompact: new Map(),
    byParent: new Map()
  };
  for (const executablePath of values) {
    const lowerPath = executablePath.toLocaleLowerCase();
    if (
      lowerPath.includes("\\windows\\") ||
      lowerPath.includes("\\winsxs\\") ||
      lowerPath.includes("\\$recycle.bin\\")
    ) {
      continue;
    }
    const stem = path.win32.basename(executablePath, path.win32.extname(executablePath));
    if (GENERIC_EXECUTABLE_NAMES.has(stem.toLocaleLowerCase())) continue;
    const parent = path.win32.dirname(executablePath);
    const parentName = path.win32.basename(parent);
    for (const token of new Set([
      ...ownershipTokens(stem),
      ...ownershipTokens(parentName)
    ])) {
      appendPortableIndex(index.byToken, token, executablePath);
    }
    appendPortableIndex(index.byCompact, compactIdentity(stem), executablePath);
    appendPortableIndex(index.byCompact, compactIdentity(parentName), executablePath);
    appendPortableIndex(index.byParent, parent.toLocaleLowerCase(), executablePath);
  }
  portablePathIndexCache = index;
  return index;
}

function portablePathsForTarget(targetPath: string, executablePaths: string[]): string[] {
  const index = portablePathIndex(executablePaths);
  const normalizedTarget = normalizeWindowsPath(targetPath).toLocaleLowerCase();
  const targetName = path.win32.basename(normalizedTarget.replace(/[\\/]+$/, ""));
  const matches = new Set<string>();
  for (const token of ownershipTokens(targetName)) {
    for (const executablePath of index.byToken.get(token) ?? []) matches.add(executablePath);
  }
  for (const executablePath of index.byCompact.get(compactIdentity(targetName)) ?? []) {
    matches.add(executablePath);
  }
  let ancestor = normalizedTarget;
  while (ancestor && ancestor !== path.win32.dirname(ancestor)) {
    for (const executablePath of index.byParent.get(ancestor) ?? []) matches.add(executablePath);
    ancestor = path.win32.dirname(ancestor);
  }
  return [...matches].slice(0, 300);
}

export function portableCandidateScores(
  targetPath: string,
  executablePaths: string[]
): OwnershipCandidate[] {
  if (executablePaths.length === 0) return [];
  const normalizedTarget = normalizeWindowsPath(targetPath).toLocaleLowerCase();
  const targetName = path.win32.basename(normalizedTarget.replace(/[\\/]+$/, ""));
  const targetCompact = compactIdentity(targetName);
  const targetTokens = new Set(ownershipTokens(targetName));
  const matches: OwnershipCandidate[] = [];
  const seen = new Set<string>();

  for (const executablePath of portablePathsForTarget(targetPath, executablePaths)) {
    const lowerPath = executablePath.toLocaleLowerCase();
    if (
      lowerPath.includes("\\windows\\") ||
      lowerPath.includes("\\winsxs\\") ||
      lowerPath.includes("\\$recycle.bin\\")
    ) {
      continue;
    }
    const stem = path.win32.basename(executablePath, path.win32.extname(executablePath));
    const stemLower = stem.toLocaleLowerCase();
    if (GENERIC_EXECUTABLE_NAMES.has(stemLower)) continue;
    const parent = path.win32.dirname(executablePath);
    const parentName = path.win32.basename(parent);
    const stemCompact = compactIdentity(stem);
    const parentCompact = compactIdentity(parentName);
    const exeTokens = new Set([
      ...ownershipTokens(stem),
      ...ownershipTokens(parentName)
    ]);
    const distinctiveOverlap = [...targetTokens].some(
      (token) => token.length >= 3 && exeTokens.has(token)
    );
    const compactMatch =
      targetCompact.length >= 3 &&
      [stemCompact, parentCompact].some(
        (candidate) =>
          candidate === targetCompact ||
          (targetCompact.length >= 5 &&
            (candidate.includes(targetCompact) || targetCompact.includes(candidate)))
      );
    const pathOverlap =
      normalizedTarget === parent.toLocaleLowerCase() ||
      normalizedTarget.startsWith(`${parent.toLocaleLowerCase()}\\`);
    if (!distinctiveOverlap && !compactMatch && !pathOverlap) continue;

    const app: InstalledApplication = {
      name: parentCompact === targetCompact && parentName ? parentName : stem,
      installLocation: parent,
      executablePath,
      displayIcon: executablePath,
      source: "portable-executable"
    };
    const candidate = candidateScore(targetPath, app);
    if (!candidate) continue;
    const key = `${candidate.appName}|${parent}`.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidate.confidence = Math.min(
      0.94,
      candidate.confidence + (compactMatch ? 0.14 : 0.06)
    );
    candidate.reason = compactMatch
      ? "目录名与全盘发现的可执行文件或其父目录高度一致"
      : candidate.reason;
    candidate.evidence.push(`全盘应用发现：${executablePath}`);
    matches.push(candidate);
  }

  return matches.sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

interface ExecutableMetadata {
  path: string;
  productName?: string;
  companyName?: string;
  fileDescription?: string;
  signatureStatus?: string;
  signer?: string;
}

async function enrichExecutableCandidates(
  candidates: OwnershipCandidate[]
): Promise<OwnershipCandidate[]> {
  const executablePaths = [
    ...new Set(
      candidates
        .flatMap((candidate) => candidate.evidence)
        .filter((item) => item.startsWith("全盘应用发现："))
        .map((item) => item.slice("全盘应用发现：".length))
    )
  ].slice(0, 12);
  if (executablePaths.length === 0) return candidates;
  const script = `
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json $env:CDRIVESHIFTAI_EXECUTABLE_PATHS
$result = foreach ($target in @($paths)) {
  try {
    $item = Get-Item -LiteralPath $target -ErrorAction Stop
    $version = $item.VersionInfo
    $signature = Get-AuthenticodeSignature -LiteralPath $target -ErrorAction SilentlyContinue
    [PSCustomObject]@{
      path = [string]$target
      productName = [string]$version.ProductName
      companyName = [string]$version.CompanyName
      fileDescription = [string]$version.FileDescription
      signatureStatus = [string]$signature.Status
      signer = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
    }
  } catch {}
}
@($result) | ConvertTo-Json -Compress -Depth 3
`;
  let metadata: ExecutableMetadata[] = [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          CDRIVESHIFTAI_EXECUTABLE_PATHS: JSON.stringify(executablePaths)
        }
      }
    );
    const value = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as
      | ExecutableMetadata
      | ExecutableMetadata[];
    metadata = Array.isArray(value) ? value : value ? [value] : [];
  } catch {
    return candidates;
  }
  const byPath = new Map(
    metadata
      .filter((item) => typeof item.path === "string")
      .map((item) => [item.path.toLocaleLowerCase(), item])
  );
  return candidates
    .map((candidate) => {
      const executablePath = candidate.evidence
        .find((item) => item.startsWith("全盘应用发现："))
        ?.slice("全盘应用发现：".length);
      if (!executablePath) return candidate;
      const details = byPath.get(executablePath.toLocaleLowerCase());
      if (!details) return candidate;
      const evidence = [...candidate.evidence];
      if (details.productName) evidence.push(`文件产品名：${details.productName}`);
      if (details.fileDescription) evidence.push(`文件描述：${details.fileDescription}`);
      if (details.companyName) evidence.push(`文件公司名：${details.companyName}`);
      if (details.signatureStatus === "Valid" && details.signer) {
        evidence.push(`数字签名有效：${details.signer}`);
      }
      return {
        ...candidate,
        appName: details.productName?.trim() || candidate.appName,
        publisher: details.companyName?.trim() || candidate.publisher,
        confidence: Math.min(
          0.98,
          candidate.confidence +
            (details.productName || details.companyName ? 0.04 : 0) +
            (details.signatureStatus === "Valid" ? 0.08 : 0)
        ),
        evidence: [...new Set(evidence)].slice(0, 8)
      };
    })
    .sort((first, second) => second.confidence - first.confidence);
}

function classifyDirectory(summary: DirectorySummary): Pick<
  AnalysisResult,
  "category" | "risk" | "recommendation" | "explanation"
> {
  const known = inferKnownDirectory(summary.path);
  if (known) {
    return {
      category: known.category,
      risk: known.risk,
      recommendation: recommendationForInsight(known),
      explanation: known.purpose
    };
  }

  const lower = summary.path.toLocaleLowerCase();
  const rootName = path.win32.basename(summary.path).toLocaleLowerCase();
  const extensions = new Set(summary.extensionBreakdown.map((item) => item.extension));
  if (protectedReason(summary.path)) {
    return {
      category: "system",
      risk: "blocked",
      recommendation: "keep",
      explanation: "该路径属于或包含 Windows / 共享系统保护区域，不应通过目录迁移处理。"
    };
  }
  if (/(\\|^)(cache|caches|temp|tmp|code cache|gpu cache)(\\|$)/i.test(lower)) {
    return {
      category: "cache",
      risk: "medium",
      recommendation: "review",
      explanation: "目录表现为缓存或临时数据，应优先使用所属应用自身的清理或存储位置设置。"
    };
  }
  if (/\\appdata\\(local|locallow|roaming)(\\|$)/i.test(lower)) {
    return {
      category: "application-data",
      risk: "medium",
      recommendation: "review",
      explanation: "这是用户级应用数据目录。可考虑迁移，但应先退出关联应用并验证更新器行为。"
    };
  }
  if (
    extensions.has(".sln") ||
    extensions.has(".csproj") ||
    summary.sampleNames.some((name) => name.toLocaleLowerCase() === ".git") ||
    ["node_modules", ".gradle", ".cargo", ".nuget", ".m2", ".venv"].includes(rootName)
  ) {
    return {
      category: "development",
      risk: "low",
      recommendation: "migrate",
      explanation: "目录包含开发工程、工具链或依赖缓存特征，通常可迁移到容量更大的磁盘。"
    };
  }
  if (isHighRiskApplicationPath(summary.path)) {
    return {
      category: "application",
      risk: "high",
      recommendation: "keep",
      explanation: "安装目录可能被更新器、服务或驱动按真实路径访问，直接迁移风险较高。"
    };
  }
  if (/\\(documents|downloads|desktop|pictures|videos|music)(\\|$)/i.test(lower)) {
    return {
      category: "user-data",
      risk: "low",
      recommendation: "migrate",
      explanation: "这是用户内容目录；Windows 已知文件夹应优先使用系统“位置”功能。"
    };
  }
  return {
    category: "unknown",
    risk: "medium",
    recommendation: "review",
    explanation: "本地证据不足，迁移前需要核对关联应用并关闭占用进程。"
  };
}

function classifyOwnershipDirectory(
  targetPath: string,
  zone: OwnershipMapEntry["zone"]
): Pick<OwnershipMapEntry, "category" | "risk" | "recommendation" | "explanation"> {
  const known = inferKnownDirectory(targetPath);
  if (known) {
    return {
      category: known.category,
      risk: known.risk,
      recommendation: recommendationForInsight(known),
      explanation: known.purpose
    };
  }
  const lower = targetPath.toLocaleLowerCase();
  const rootName = path.win32.basename(targetPath).toLocaleLowerCase();
  if (protectedReason(targetPath)) {
    return {
      category: "system",
      risk: "blocked",
      recommendation: "keep",
      explanation: "Windows 或共享系统保护目录，不应迁移或删除。"
    };
  }
  if (/(\\|^)(cache|caches|temp|tmp|code cache|gpu cache)(\\|$)/i.test(lower)) {
    return {
      category: "cache",
      risk: "medium",
      recommendation: "review",
      explanation: "缓存或临时数据，优先使用所属应用的清理与存储位置设置。"
    };
  }
  if (zone === "program-files" || isHighRiskApplicationPath(targetPath)) {
    return {
      category: "application",
      risk: "high",
      recommendation: "keep",
      explanation: "应用安装目录，可能包含程序、更新器、服务或运行库。"
    };
  }
  if (zone === "app-data" || zone === "program-data") {
    return {
      category: "application-data",
      risk: "medium",
      recommendation: "review",
      explanation: "应用运行数据、配置或共享数据；所属应用可能安装在其他磁盘。"
    };
  }
  if (
    ["node_modules", ".gradle", ".cargo", ".nuget", ".cache", ".venv", "target"].includes(
      rootName
    ) ||
    /\\(development|projects?|repos?|source|workspace)(\\|$)/i.test(lower)
  ) {
    return {
      category: "development",
      risk: "low",
      recommendation: "migrate",
      explanation: "开发工程、依赖或工具链数据，通常适合迁移到容量更大的磁盘。"
    };
  }
  if (/\\(documents|downloads|desktop|pictures|videos|music)(\\|$)/i.test(lower)) {
    return {
      category: "user-data",
      risk: "low",
      recommendation: "migrate",
      explanation: "用户文件或个人工作目录；已知文件夹优先使用 Windows“位置”功能。"
    };
  }
  return {
    category: "unknown",
    risk: "medium",
    recommendation: "review",
    explanation: "尚未发现足够的应用或路径证据，需要进入详细分析确认。"
  };
}

function zoneForPath(targetPath: string): OwnershipMapEntry["zone"] {
  const lower = targetPath.toLocaleLowerCase();
  if (lower.includes("\\program files\\")) return "program-files";
  if (lower.includes("\\programdata\\")) return "program-data";
  if (lower.includes("\\appdata\\")) return "app-data";
  if (lower.includes("\\users\\")) return "user-profile";
  return "drive-root";
}

function defaultPurpose(
  category: AnalysisResult["category"],
  owner?: OwnershipCandidate
): string {
  if (owner) {
    return `${owner.appName} 的${
      category === "application" ? "程序安装文件" : "运行数据、配置或缓存"
    }`;
  }
  const labels: Record<AnalysisResult["category"], string> = {
    application: "应用程序安装或运行文件",
    "application-data": "应用运行数据、配置或缓存",
    cache: "缓存或临时数据",
    "user-data": "用户创建或保存的个人数据",
    development: "开发工程、依赖或工具链数据",
    system: "Windows 系统或共享组件数据",
    unknown: "用途尚未确定的目录数据"
  };
  return labels[category];
}

function buildPathInsight(
  targetPath: string,
  classification: Pick<
    AnalysisResult,
    "category" | "risk" | "recommendation" | "explanation"
  >,
  owner?: OwnershipCandidate
): DirectoryInsight {
  const known = inferKnownDirectory(targetPath);
  if (known) return known;
  const confidence = owner?.confidence ?? (classification.category === "unknown" ? 0.32 : 0.72);
  return {
    path: targetPath,
    name: path.win32.basename(targetPath.replace(/[\\/]+$/, "")) || targetPath,
    purpose: defaultPurpose(classification.category, owner),
    producedBy: owner?.appName,
    howGenerated: owner
      ? `根据已安装应用记录、目录名和路径关系判断由 ${owner.appName} 创建或使用。`
      : classification.explanation,
    category: classification.category,
    confidence,
    risk: classification.risk,
    riskReason:
      classification.risk === "blocked"
        ? "系统保护路径不允许迁移。"
        : classification.risk === "high"
          ? "应用、服务或更新器可能依赖真实路径，迁移前必须退出相关进程并准备回滚。"
          : classification.risk === "medium"
            ? "归属或运行时占用仍需确认，迁移前应退出关联应用。"
            : "未发现系统保护或强运行时依赖，但仍需完成迁移预检。",
    source: owner ? "installed-app" : "path-rule",
    evidence: owner?.evidence ?? [classification.explanation],
    webSources: []
  };
}

interface OwnershipPathCandidate {
  path: string;
  name: string;
  zone: OwnershipMapEntry["zone"];
}

async function listOwnershipChildren(
  container: string,
  zone: OwnershipMapEntry["zone"],
  scanErrors: string[],
  maximum = 1_200
): Promise<OwnershipPathCandidate[]> {
  try {
    const children = await readdir(container, { withFileTypes: true });
    return children
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, maximum)
      .map((entry) => ({
        path: path.join(container, entry.name),
        name: entry.name,
        zone
      }));
  } catch (error) {
    if (scanErrors.length < 24) {
      scanErrors.push(`${container}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  }
}

export async function scanOwnershipMap(
  inputDrive: string,
  executablePaths: string[] = []
): Promise<OwnershipMapResult> {
  const started = performance.now();
  const drive = normalizeWindowsPath(inputDrive);
  if (!/^[a-z]:\\$/i.test(drive)) throw new Error("请选择一个本地盘符");
  const roots = await getLocalDriveRoots();
  if (!roots.some((root) => samePath(root, drive))) throw new Error("所选盘符当前不可用");

  const scanErrors: string[] = [];
  const candidates = new Map<string, OwnershipPathCandidate>();
  const append = (items: OwnershipPathCandidate[]) => {
    for (const item of items) candidates.set(item.path.toLocaleLowerCase(), item);
  };

  append(await listOwnershipChildren(drive, "drive-root", scanErrors, 800));

  for (const container of [
    path.join(drive, "Program Files"),
    path.join(drive, "Program Files (x86)")
  ]) {
    append(await listOwnershipChildren(container, "program-files", scanErrors));
  }
  append(
    await listOwnershipChildren(path.join(drive, "ProgramData"), "program-data", scanErrors)
  );

  const currentProfile = normalizeWindowsPath(os.homedir());
  if (samePath(path.parse(currentProfile).root, drive)) {
    append(await listOwnershipChildren(currentProfile, "user-profile", scanErrors));
    for (const container of [
      path.join(currentProfile, "AppData", "Local"),
      path.join(currentProfile, "AppData", "LocalLow"),
      path.join(currentProfile, "AppData", "Roaming")
    ]) {
      append(await listOwnershipChildren(container, "app-data", scanErrors, 2_000));
    }
  }

  const applications = await listInstalledApplications();
  const preparedApplications = applications.map(prepareApplication);
  const candidateItems = [...candidates.values()];
  const entries: OwnershipMapEntry[] = [];
  const concurrency = 24;
  for (let offset = 0; offset < candidateItems.length; offset += concurrency) {
    const batch = candidateItems.slice(offset, offset + concurrency);
    const resolved = await Promise.all(
      batch.map(async (item): Promise<OwnershipMapEntry | undefined> => {
        let stats;
        try {
          stats = await lstat(item.path);
        } catch {
          return undefined;
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
        const classification = classifyOwnershipDirectory(item.path, item.zone);
        const normalizedItemPath = normalizeWindowsPath(item.path).toLocaleLowerCase();
        const pathTokens = new Set(ownershipTokens(item.name));
        const installedCandidates =
          classification.category === "system" || classification.category === "user-data"
            ? []
            : preparedApplications
                .map((application) =>
                  candidateScorePrepared(normalizedItemPath, pathTokens, application)
                )
                .filter((candidate): candidate is OwnershipCandidate => Boolean(candidate))
                .sort((a, b) => b.confidence - a.confidence);
        const known = inferKnownDirectory(item.path);
        const knownCandidate =
          known?.producedBy &&
          !["Microsoft Windows", "Windows 与已安装应用", "上级应用或系统组件"].includes(
            known.producedBy
          )
            ? {
                appName: known.producedBy,
                confidence: known.confidence,
                reason: known.evidence[0] ?? "标准目录签名匹配",
                evidence: known.evidence
              }
            : undefined;
        const ownershipCandidates = [
          ...(knownCandidate ? [knownCandidate] : []),
          ...installedCandidates,
          ...portableCandidateScores(item.path, executablePaths)
        ]
          .sort((a, b) => b.confidence - a.confidence)
          .filter(
            (candidate, index, all) =>
              all.findIndex(
                (itemCandidate) =>
                  itemCandidate.appName.toLocaleLowerCase() ===
                  candidate.appName.toLocaleLowerCase()
              ) === index
          );
        return {
          ...item,
          ...classification,
          owner: ownershipCandidates[0],
          candidateCount: ownershipCandidates.length,
          lastModified: stats.mtime.toISOString()
        };
      })
    );
    entries.push(...resolved.filter((entry): entry is OwnershipMapEntry => Boolean(entry)));
  }

  entries.sort((a, b) => {
    const riskOrder = { blocked: 0, high: 1, medium: 2, low: 3 };
    return riskOrder[a.risk] - riskOrder[b.risk] || a.name.localeCompare(b.name, "zh-CN");
  });
  return {
    drive,
    scannedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    installedApplications: applications.length,
    portableExecutables: executablePaths.length,
    entries,
    scanErrors
  };
}

export async function analyzeLocally(
  inputPath: string,
  existingSummary?: DirectorySummary,
  executablePaths: string[] = []
): Promise<AnalysisResult> {
  const summary = existingSummary ?? (await summarizeDirectory(inputPath));
  const apps = await listInstalledApplications();
  const installedCandidates = apps
    .map((app) => candidateScore(summary.path, app))
    .filter((candidate): candidate is OwnershipCandidate => Boolean(candidate));
  const known = inferKnownDirectory(summary.path);
  const knownCandidate: OwnershipCandidate | undefined =
    known?.producedBy &&
    ![
      "Microsoft Windows",
      "Windows 与已安装应用",
      "Windows 用户配置与用户本人",
      "上级应用或系统组件"
    ].includes(known.producedBy)
      ? {
          appName: known.producedBy,
          confidence: known.confidence,
          reason: known.evidence[0] ?? "标准目录签名匹配",
          evidence: known.evidence
        }
      : undefined;
  const preliminaryCandidates = [
    ...(knownCandidate ? [knownCandidate] : []),
    ...installedCandidates,
    ...portableCandidateScores(summary.path, executablePaths)
  ]
    .sort((a, b) => b.confidence - a.confidence)
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (item) =>
            item.appName.toLocaleLowerCase() === candidate.appName.toLocaleLowerCase() &&
            (item.installLocation ?? "").toLocaleLowerCase() ===
              (candidate.installLocation ?? "").toLocaleLowerCase()
        ) === index
    )
    .slice(0, 8);
  const candidates = await enrichExecutableCandidates(preliminaryCandidates);

  const classification = classifyDirectory(summary);
  const targetInsight = buildPathInsight(summary.path, classification, candidates[0]);
  const preparedApplications = apps.map(prepareApplication);
  const childInsights = summary.largestChildren.slice(0, 16).map((child) => {
    const childClassification = classifyOwnershipDirectory(
      child.path,
      zoneForPath(child.path)
    );
    const normalizedChild = normalizeWindowsPath(child.path).toLocaleLowerCase();
    const childTokens = new Set(
      ownershipTokens(path.win32.basename(child.path.replace(/[\\/]+$/, "")))
    );
    const installedOwner = preparedApplications
      .map((application) =>
        candidateScorePrepared(normalizedChild, childTokens, application)
      )
      .filter((candidate): candidate is OwnershipCandidate => Boolean(candidate))
      .sort((a, b) => b.confidence - a.confidence)[0];
    const portableOwner = portableCandidateScores(child.path, executablePaths)[0];
    const owner =
      !installedOwner ||
      (portableOwner?.confidence ?? 0) > installedOwner.confidence
        ? portableOwner
        : installedOwner;
    const insight = buildPathInsight(child.path, childClassification, owner);
    if (
      insight.category === "unknown" &&
      targetInsight.producedBy &&
      targetInsight.category !== "unknown"
    ) {
      return {
        ...insight,
        purpose: `${targetInsight.producedBy} 的子目录或组成数据；具体职责需结合文件特征继续判断`,
        producedBy: targetInsight.producedBy,
        howGenerated: `由 ${targetInsight.producedBy} 在使用父目录时创建或维护。`,
        category: targetInsight.category,
        confidence: Math.min(0.89, Math.max(0.6, targetInsight.confidence * 0.78)),
        risk: targetInsight.risk,
        riskReason: targetInsight.riskReason,
        source: targetInsight.source,
        evidence: [
          ...new Set([
            ...insight.evidence,
            `继承父目录归属：${targetInsight.producedBy}`
          ])
        ]
      };
    }
    return insight;
  });

  const warnings: string[] = [];
  if (summary.scanErrors.length > 0) {
    warnings.push("部分条目无法读取，空间统计和目录画像可能偏小。");
  }
  if (summary.fileCount > 200_000) {
    warnings.push("目录文件数量较多，复制与逐项校验可能耗时。");
  }
  if (targetInsight.confidence < 0.58) {
    warnings.push("当前归属可信度较低；启用 AI 后会对低可信目录进行二次判断和必要的网络补证。");
  }
  if (classification.risk !== "low") {
    warnings.push("迁移前请完全退出关联应用，并暂停同步、更新与杀毒实时扫描。");
  }
  if (known?.riskReason) warnings.push(known.riskReason);

  const analyzedAt = new Date().toISOString();
  return {
    summary,
    ...classification,
    purpose: targetInsight.purpose,
    producedBy: targetInsight.producedBy,
    howGenerated: targetInsight.howGenerated,
    confidence: targetInsight.confidence,
    riskReason: targetInsight.riskReason,
    insights: [targetInsight, ...childInsights],
    snapshot: {
      analyzedAt,
      totalBytes: summary.totalBytes,
      fileCount: summary.fileCount,
      directoryCount: summary.directoryCount,
      lastModified: summary.lastModified
    },
    candidates,
    warnings: [...new Set(warnings)],
    source: "local",
    webResearchUsed: false
  };
}
