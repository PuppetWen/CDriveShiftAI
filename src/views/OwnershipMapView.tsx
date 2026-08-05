import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  AlertTriangle,
  AppWindow,
  ArrowRightLeft,
  Boxes,
  Braces,
  CircleHelp,
  Database,
  ExternalLink,
  Folder,
  HardDrive,
  Map as MapIcon,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type {
  AnalysisResult,
  DriveInfo,
  OwnershipMapEntry,
  OwnershipMapResult
} from "../types";
import { OwnershipContextMenu } from "../components/OwnershipContextMenu";
import { PathPropertiesDialog } from "../components/PathPropertiesDialog";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { ThemedTooltip } from "../components/ThemedTooltip";
import { Badge, EmptyState, PageTitle } from "../components/ui";

type UiText = (zh: string, en: string) => string;

function categoryLabel(category: AnalysisResult["category"], ui: UiText): string {
  return {
    application: ui("应用安装目录", "Application directory"),
    "application-data": ui("应用数据", "Application data"),
    cache: ui("缓存/临时数据", "Cache / temporary data"),
    "user-data": ui("用户数据", "User data"),
    development: ui("开发数据", "Development data"),
    system: ui("系统组件", "System component"),
    unknown: ui("待识别", "Unidentified")
  }[category];
}

const categoryIcons = {
  application: Package,
  "application-data": Database,
  cache: Boxes,
  "user-data": UserRound,
  development: Braces,
  system: ShieldCheck,
  unknown: CircleHelp
};

function zoneLabel(zone: OwnershipMapEntry["zone"], ui: UiText): string {
  return {
    "drive-root": ui("盘符根目录", "Drive root"),
    "program-files": ui("程序安装区", "Program installation area"),
    "program-data": ui("全局应用数据", "Shared application data"),
    "app-data": ui("当前用户应用数据", "Current-user application data"),
    "user-profile": ui("当前用户目录", "Current-user profile")
  }[zone];
}

type CategoryFilter = "all" | AnalysisResult["category"];

interface OwnershipMapViewProps {
  drives: DriveInfo[];
  onAnalyze: (path: string) => void;
  onMigrate: (path: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

export function OwnershipMapView({
  drives,
  onAnalyze,
  onMigrate,
  notify
}: OwnershipMapViewProps) {
  const { t, ui, runtimeText, formatNumber, formatDate: formatLocaleDate } = useI18n();
  const [drive, setDrive] = useState("");
  const [result, setResult] = useState<OwnershipMapResult>();
  const [loading, setLoading] = useState(false);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [contextMenu, setContextMenu] = useState<{
    entry: OwnershipMapEntry;
    x: number;
    y: number;
  }>();
  const [propertyPath, setPropertyPath] = useState("");
  const requestSequence = useRef(0);
  const { feedback, openFromDoubleClick, classNameFor } = usePathOpenFeedback(notify);

  useEffect(() => {
    if (drive || drives.length === 0) return;
    setDrive(drives.find((item) => item.root.toUpperCase().startsWith("C:"))?.root ?? drives[0].root);
  }, [drive, drives]);

  const scan = useCallback(
    async (selectedDrive = drive) => {
      if (!selectedDrive) return;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setRestored(false);
      try {
        const next = await api.scanOwnershipMap(selectedDrive);
        if (sequence !== requestSequence.current) return;
        setResult(next);
      } catch (error) {
        if (sequence === requestSequence.current) {
          notify("error", error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [drive, notify]
  );

  const restoreOrScan = useCallback(
    async (selectedDrive: string) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      try {
        const saved = await api.getSavedOwnershipMap(selectedDrive);
        if (sequence !== requestSequence.current) return;
        if (saved) {
          setResult(saved);
          setRestored(true);
          return;
        }
        setRestored(false);
        const next = await api.scanOwnershipMap(selectedDrive);
        if (sequence !== requestSequence.current) return;
        setResult(next);
      } catch (error) {
        if (sequence === requestSequence.current) {
          notify("error", error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    if (drive) void restoreOrScan(drive);
  }, [drive, restoreOrScan]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (result?.entries ?? []).filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (!needle) return true;
      return (
        entry.path.toLocaleLowerCase().includes(needle) ||
        entry.owner?.appName.toLocaleLowerCase().includes(needle) ||
        entry.owner?.publisher?.toLocaleLowerCase().includes(needle)
      );
    });
  }, [category, query, result]);

  const counts = useMemo(() => {
    const output = new Map<AnalysisResult["category"], number>();
    for (const entry of result?.entries ?? []) {
      output.set(entry.category, (output.get(entry.category) ?? 0) + 1);
    }
    return output;
  }, [result]);

  const showContextMenu = (event: MouseEvent, entry: OwnershipMapEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 368)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 530))
    });
  };

  const removeEntry = (targetPath: string) => {
    setResult((current) =>
      current
        ? { ...current, entries: current.entries.filter((item) => item.path !== targetPath) }
        : current
    );
  };

  const renameEntry = (oldPath: string, newPath: string) => {
    const name = newPath.split(/[\\/]/).pop() ?? newPath;
    setResult((current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              entry.path === oldPath ? { ...entry, path: newPath, name } : entry
            )
          }
        : current
    );
    setPropertyPath(newPath);
  };

  return (
    <div className="page ownership-map-page">
      <PageTitle
        eyebrow="DISK OWNERSHIP MAP"
        title={t("page.ownershipTitle")}
        description={t("page.ownershipDescription")}
        action={
          <button
            className="primary-button"
            type="button"
            disabled={!drive || loading}
            onClick={() => void scan()}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            {loading
              ? ui("正在扫描…", "Scanning…")
              : result
                ? ui("重新扫描", "Scan again")
                : ui("建立归属地图", "Build ownership map")}
          </button>
        }
      />

      <section className="ownership-toolbar glass-card">
        <div className="ownership-drive-switch" aria-label={ui("选择盘符", "Choose a drive")}>
          <HardDrive size={17} />
          {drives.map((item) => (
            <button
              type="button"
              className={drive === item.root ? "active" : ""}
              onClick={() => {
                setResult(undefined);
                setDrive(item.root);
              }}
              key={item.root}
            >
              {item.root.slice(0, 2)}
              <span>{item.name}</span>
            </button>
          ))}
        </div>
        <label className="ownership-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={ui("筛选目录、应用或发布者", "Filter by directory, application, or publisher")}
          />
        </label>
      </section>

      <section className="ownership-summary">
        <article className="glass-card ownership-metric accent">
          <MapIcon size={20} />
          <div>
            <span>{ui("已识别目录", "Identified directories")}</span>
            <strong>{result ? formatNumber(result.entries.length) : "—"}</strong>
          </div>
          <small>{result ? `${result.durationMs.toFixed(0)} ms` : ui("等待扫描", "Waiting to scan")}</small>
        </article>
        <article className="glass-card ownership-metric">
          <Package size={20} />
          <div>
            <span>{ui("应用安装目录", "Application directories")}</span>
            <strong>{counts.get("application") ?? 0}</strong>
          </div>
          <small>{ui("更新器与服务风险较高", "Updaters and services carry more risk")}</small>
        </article>
        <article className="glass-card ownership-metric">
          <Database size={20} />
          <div>
            <span>{ui("应用数据与缓存", "Application data and cache")}</span>
            <strong>
              {(counts.get("application-data") ?? 0) + (counts.get("cache") ?? 0)}
            </strong>
          </div>
          <small>{ui("可能归属于其他盘应用", "May belong to applications on another drive")}</small>
        </article>
        <article className="glass-card ownership-metric warning">
          <CircleHelp size={20} />
          <div>
            <span>{ui("需要复核", "Needs review")}</span>
            <strong>{counts.get("unknown") ?? 0}</strong>
          </div>
          <small>{ui("可进入详细归属分析", "Open detailed ownership analysis")}</small>
        </article>
      </section>

      <section className="ownership-board glass-card">
        <div className="ownership-board-head">
          <div className="ownership-category-tabs">
            {(
              [
                ["all", ui("全部", "All")],
                ["application", ui("安装目录", "Applications")],
                ["application-data", ui("应用数据", "App data")],
                ["cache", ui("缓存", "Cache")],
                ["user-data", ui("用户数据", "User data")],
                ["development", ui("开发", "Development")],
                ["system", ui("系统", "System")],
                ["unknown", ui("待识别", "Unidentified")]
              ] as Array<[CategoryFilter, string]>
            ).map(([value, label]) => (
              <button
                type="button"
                className={category === value ? "active" : ""}
                onClick={() => setCategory(value)}
                key={value}
              >
                {label}
                {value !== "all" && <span>{counts.get(value) ?? 0}</span>}
              </button>
            ))}
          </div>
          <div className="ownership-scan-meta">
            {result && (
              <>
                <AppWindow size={14} />
                <span>
                  {restored ? ui("已恢复上次结果", "Previous result restored") : ui("本次扫描结果", "Current scan result")} · {formatLocaleDate(result.scannedAt)}
                </span>
                <span>
                  {formatNumber(result.installedApplications)} {ui("条应用记录", "application records")} ·{" "}
                  {formatNumber(result.portableExecutables)} {ui("个全盘程序", "portable executables")}
                </span>
              </>
            )}
          </div>
        </div>

        {loading && !result ? (
          <div className="ownership-loading">
            <span className="spinner" />
            <strong>{ui("正在建立", "Building")} {drive.slice(0, 2)} {ui("目录归属图谱", "directory ownership map")}</strong>
            <p>{ui("快速扫描只读取目录元数据和卸载注册表，不递归读取文件正文。", "The fast scan reads directory metadata and uninstall registry entries without recursively reading file contents.")}</p>
          </div>
        ) : filtered.length > 0 ? (
          <div className="ownership-list">
            <div className="ownership-table-head" role="row">
              <span>{ui("类型", "Type")}</span>
              <span>{ui("目录 / 分类", "Directory / category")}</span>
              <span>{ui("归属应用 / 可信度", "Owning application / confidence")}</span>
              <span>{ui("操作", "Actions")}</span>
            </div>
            {filtered.map((entry) => {
              const Icon = categoryIcons[entry.category];
              const ownerDrive = entry.owner?.installLocation?.slice(0, 2).toUpperCase();
              const selectedDrive = drive.slice(0, 2).toUpperCase();
              return (
                <article
                  className={`ownership-row path-openable ${
                    contextMenu?.entry.path === entry.path ? "context-active" : ""
                  } ${classNameFor(entry.path)}`}
                  key={entry.path}
                  onDoubleClick={(event) => openFromDoubleClick(event, entry.path)}
                  onContextMenu={(event) => showContextMenu(event, entry)}
                  aria-label={`${entry.name}; ${ui("双击打开目录，右键查看更多操作", "double-click to open; right-click for more actions")}`}
                >
                  <div className={`ownership-type ${entry.category}`}>
                    <Icon size={18} />
                  </div>
                  <div className="ownership-path">
                    <div>
                      <strong>{entry.name}</strong>
                      <Badge
                        tone={
                          entry.risk === "low"
                            ? "good"
                            : entry.risk === "medium"
                              ? "warn"
                              : "danger"
                        }
                      >
                        {categoryLabel(entry.category, ui)}
                      </Badge>
                      <span className="zone-label">{zoneLabel(entry.zone, ui)}</span>
                    </div>
                    <p>{entry.path}</p>
                  </div>
                  <div className="ownership-owner">
                    {entry.owner ? (
                      <>
                        <strong>{runtimeText(entry.owner.appName)}</strong>
                        <span>
                          {ownerDrive && ownerDrive !== selectedDrive
                            ? ui(`应用安装在 ${ownerDrive}，这里是其关联目录`, `The application is installed on ${ownerDrive}; this is a related directory`)
                            : runtimeText(entry.owner.publisher ?? entry.owner.reason)}
                        </span>
                        <small>{Math.round(entry.owner.confidence * 100)}% {ui("本地证据置信度", "local-evidence confidence")}</small>
                      </>
                    ) : (
                      <>
                        <strong>{ui("尚未匹配应用", "No application matched")}</strong>
                        <span>{runtimeText(entry.explanation)}</span>
                        <small>{entry.lastModified ? formatLocaleDate(entry.lastModified) : "—"}</small>
                      </>
                    )}
                  </div>
                  <div className="ownership-actions">
                    <ThemedTooltip content={ui("在文件资源管理器中定位这个目录", "Reveal this directory in File Explorer")}>
                      <button
                        type="button"
                        aria-label={ui("在文件资源管理器中定位", "Reveal in File Explorer")}
                        onClick={() => void api.revealPath(entry.path)}
                      >
                        <ExternalLink size={15} />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content={ui("打开详细归属分析，并按当前 AI 设置继续核对", "Open detailed ownership analysis using the current AI settings")}>
                      <button
                        type="button"
                        aria-label={ui("详细归属分析", "Detailed ownership analysis")}
                        onClick={() => onAnalyze(entry.path)}
                      >
                        <Sparkles size={15} />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip
                      content={
                        entry.risk === "blocked"
                          ? ui("Windows 系统保护目录禁止迁移", "Windows-protected directories cannot be migrated")
                          : ui("将这个目录带入可恢复的安全迁移流程", "Send this directory to the recoverable migration workflow")
                      }
                    >
                      <button
                        type="button"
                        aria-label={entry.risk === "blocked" ? ui("系统保护目录禁止迁移", "Protected directory cannot be migrated") : ui("进入安全迁移", "Open safe migration")}
                        disabled={entry.risk === "blocked"}
                        onClick={() => onMigrate(entry.path)}
                      >
                        <ArrowRightLeft size={15} />
                      </button>
                    </ThemedTooltip>
                  </div>
                  <PathOpenFeedback path={entry.path} feedback={feedback} />
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={<Folder size={28} />} title={ui("当前筛选没有目录", "No directories match the current filters")}>
            {result
              ? ui("尝试切换分类或清除筛选关键词。", "Try another category or clear the filter text.")
              : ui("选择一个盘符后，应用会自动构建目录归属地图。", "Choose a drive and the application will build its ownership map automatically.")}
          </EmptyState>
        )}

        {result && result.scanErrors.length > 0 && (
          <div className="ownership-errors">
            <AlertTriangle size={14} />
            {formatNumber(result.scanErrors.length)} {ui("个受权限限制的目录未能展开；系统保护区仍会保留在地图中。", "permission-restricted directories could not be expanded; protected system areas remain visible on the map.")}
          </div>
        )}
      </section>

      {contextMenu && (
        <OwnershipContextMenu
          {...contextMenu}
          onClose={() => setContextMenu(undefined)}
          onAnalyze={onAnalyze}
          onMigrate={onMigrate}
          onProperties={setPropertyPath}
          onDeleted={removeEntry}
          notify={notify}
        />
      )}
      {propertyPath && (
        <PathPropertiesDialog
          path={propertyPath}
          onClose={() => setPropertyPath("")}
          onRenamed={renameEntry}
          notify={notify}
        />
      )}
    </div>
  );
}
