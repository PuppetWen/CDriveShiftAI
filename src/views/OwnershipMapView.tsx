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
import { formatDate } from "../lib/format";
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

const categoryLabels: Record<AnalysisResult["category"], string> = {
  application: "应用安装目录",
  "application-data": "应用数据",
  cache: "缓存/临时数据",
  "user-data": "用户数据",
  development: "开发数据",
  system: "系统组件",
  unknown: "待识别"
};

const categoryIcons = {
  application: Package,
  "application-data": Database,
  cache: Boxes,
  "user-data": UserRound,
  development: Braces,
  system: ShieldCheck,
  unknown: CircleHelp
};

const zoneLabels: Record<OwnershipMapEntry["zone"], string> = {
  "drive-root": "盘符根目录",
  "program-files": "程序安装区",
  "program-data": "全局应用数据",
  "app-data": "当前用户应用数据",
  "user-profile": "当前用户目录"
};

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
        title="磁盘目录归属地图"
        description="罗列盘符根目录、程序安装区、ProgramData 和当前用户 AppData，识别应用安装目录与应用数据，即使所属应用安装在其他磁盘。"
        action={
          <button
            className="primary-button"
            type="button"
            disabled={!drive || loading}
            onClick={() => void scan()}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            {loading ? "正在扫描…" : result ? "重新扫描" : "建立归属地图"}
          </button>
        }
      />

      <section className="ownership-toolbar glass-card">
        <div className="ownership-drive-switch" aria-label="选择盘符">
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
            placeholder="筛选目录、应用或发布者"
          />
        </label>
      </section>

      <section className="ownership-summary">
        <article className="glass-card ownership-metric accent">
          <MapIcon size={20} />
          <div>
            <span>已识别目录</span>
            <strong>{result?.entries.length.toLocaleString() ?? "—"}</strong>
          </div>
          <small>{result ? `${result.durationMs.toFixed(0)} ms` : "等待扫描"}</small>
        </article>
        <article className="glass-card ownership-metric">
          <Package size={20} />
          <div>
            <span>应用安装目录</span>
            <strong>{counts.get("application") ?? 0}</strong>
          </div>
          <small>更新器与服务风险较高</small>
        </article>
        <article className="glass-card ownership-metric">
          <Database size={20} />
          <div>
            <span>应用数据与缓存</span>
            <strong>
              {(counts.get("application-data") ?? 0) + (counts.get("cache") ?? 0)}
            </strong>
          </div>
          <small>可能归属于其他盘应用</small>
        </article>
        <article className="glass-card ownership-metric warning">
          <CircleHelp size={20} />
          <div>
            <span>需要复核</span>
            <strong>{counts.get("unknown") ?? 0}</strong>
          </div>
          <small>可进入详细归属分析</small>
        </article>
      </section>

      <section className="ownership-board glass-card">
        <div className="ownership-board-head">
          <div className="ownership-category-tabs">
            {(
              [
                ["all", "全部"],
                ["application", "安装目录"],
                ["application-data", "应用数据"],
                ["cache", "缓存"],
                ["user-data", "用户数据"],
                ["development", "开发"],
                ["system", "系统"],
                ["unknown", "待识别"]
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
                  {restored ? "已恢复上次结果" : "本次扫描结果"} · {formatDate(result.scannedAt)}
                </span>
                <span>
                  {result.installedApplications.toLocaleString()} 条应用记录 ·{" "}
                  {result.portableExecutables.toLocaleString()} 个全盘程序
                </span>
              </>
            )}
          </div>
        </div>

        {loading && !result ? (
          <div className="ownership-loading">
            <span className="spinner" />
            <strong>正在建立 {drive.slice(0, 2)} 目录归属图谱</strong>
            <p>快速扫描只读取目录元数据和卸载注册表，不递归读取文件正文。</p>
          </div>
        ) : filtered.length > 0 ? (
          <div className="ownership-list">
            <div className="ownership-table-head" role="row">
              <span>类型</span>
              <span>目录 / 分类</span>
              <span>归属应用 / 可信度</span>
              <span>操作</span>
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
                  aria-label={`${entry.name}；双击打开目录，右键查看更多操作`}
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
                        {categoryLabels[entry.category]}
                      </Badge>
                      <span className="zone-label">{zoneLabels[entry.zone]}</span>
                    </div>
                    <p>{entry.path}</p>
                  </div>
                  <div className="ownership-owner">
                    {entry.owner ? (
                      <>
                        <strong>{entry.owner.appName}</strong>
                        <span>
                          {ownerDrive && ownerDrive !== selectedDrive
                            ? `应用安装在 ${ownerDrive}，这里是其关联目录`
                            : entry.owner.publisher ?? entry.owner.reason}
                        </span>
                        <small>{Math.round(entry.owner.confidence * 100)}% 本地证据置信度</small>
                      </>
                    ) : (
                      <>
                        <strong>尚未匹配应用</strong>
                        <span>{entry.explanation}</span>
                        <small>{formatDate(entry.lastModified)}</small>
                      </>
                    )}
                  </div>
                  <div className="ownership-actions">
                    <ThemedTooltip content="在文件资源管理器中定位这个目录">
                      <button
                        type="button"
                        aria-label="在文件资源管理器中定位"
                        onClick={() => void api.revealPath(entry.path)}
                      >
                        <ExternalLink size={15} />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content="打开详细归属分析，并按当前 AI 设置继续核对">
                      <button
                        type="button"
                        aria-label="详细归属分析"
                        onClick={() => onAnalyze(entry.path)}
                      >
                        <Sparkles size={15} />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip
                      content={
                        entry.risk === "blocked"
                          ? "Windows 系统保护目录禁止迁移"
                          : "将这个目录带入可恢复的安全迁移流程"
                      }
                    >
                      <button
                        type="button"
                        aria-label={entry.risk === "blocked" ? "系统保护目录禁止迁移" : "进入安全迁移"}
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
          <EmptyState icon={<Folder size={28} />} title="当前筛选没有目录">
            {result
              ? "尝试切换分类或清除筛选关键词。"
              : "选择一个盘符后，应用会自动构建目录归属地图。"}
          </EmptyState>
        )}

        {result && result.scanErrors.length > 0 && (
          <div className="ownership-errors">
            <AlertTriangle size={14} />
            {result.scanErrors.length} 个受权限限制的目录未能展开；系统保护区仍会保留在地图中。
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
