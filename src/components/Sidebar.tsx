import {
  ArrowRightLeft,
  History,
  LayoutDashboard,
  Map,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AppUpdateInfo, IndexerStatus, ViewId } from "../types";
import { ThemedTooltip } from "./ThemedTooltip";

const items: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "空间总览", icon: LayoutDashboard },
  { id: "search", label: "极速搜索", icon: Search },
  { id: "ownership-map", label: "磁盘归属地图", icon: Map },
  { id: "analyze", label: "AI 归属分析", icon: ScanSearch },
  { id: "migrate", label: "安全迁移", icon: ArrowRightLeft },
  { id: "history", label: "迁移记录", icon: History }
];

interface SidebarProps {
  active: ViewId;
  onChange: (view: ViewId) => void;
  indexer: IndexerStatus;
  collapsed: boolean;
  onToggle: () => void;
  updateInfo?: AppUpdateInfo;
}

export function Sidebar({
  active,
  onChange,
  indexer,
  collapsed,
  onToggle,
  updateInfo
}: SidebarProps) {
  const ready = indexer.state === "ready";
  const updateStatus = updateInfo?.updateAvailable
    ? "available"
    : updateInfo?.status ?? "checking";
  const updateTooltip =
    updateStatus === "available"
      ? updateInfo?.status === "unavailable"
        ? `已检测到新版本 v${updateInfo?.latestVersion ?? "未知"}；本次联网复查失败，但不会清除已确认的更新。点击进入设置查看。`
        : `发现新版本 v${updateInfo?.latestVersion ?? "未知"}；当前为 v${updateInfo?.currentVersion ?? "未知"}。点击进入设置更新。`
      : updateStatus === "unavailable"
        ? `暂时无法检查版本：${updateInfo?.message ?? "请稍后重试"}。点击进入设置查看。`
        : updateStatus === "current"
          ? `当前版本 v${updateInfo?.currentVersion ?? "未知"}，已是最新版本。`
          : "正在检查 GitHub Release 版本…";

  return (
    <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <div className="brand">
        <div className="brand-mark">
          <Sparkles size={19} strokeWidth={2.2} />
          <span />
        </div>
        <div className="brand-copy">
          <div className="brand-title-row">
            <strong>CDriveShiftAI</strong>
            <ThemedTooltip content={updateTooltip} delay={180}>
              <button
                type="button"
                className={`brand-update-button ${updateStatus}`}
                aria-label={updateTooltip}
                onClick={() => onChange("settings")}
              >
                <span className="brand-update-dot" />
              </button>
            </ThemedTooltip>
          </div>
          <small>全盘 AI 智迁</small>
        </div>
        <button
          type="button"
          className="sidebar-collapse-button"
          title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="side-nav" aria-label="主要导航">
        <span className="nav-caption">工作台</span>
        {items.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            className={active === id ? "nav-item active" : "nav-item"}
            onClick={() => onChange(id)}
            title={collapsed ? label : undefined}
            key={id}
          >
            <Icon size={18} />
            <span>{label}</span>
            {active === id && <i />}
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={active === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => onChange("settings")}
          title={collapsed ? "设置" : undefined}
        >
          <Settings2 size={18} />
          <span>设置</span>
          {active === "settings" && <i />}
        </button>
        <div className={`index-mini ${ready ? "is-ready" : ""}`}>
          <div className="index-mini-icon">
            {ready ? <ShieldCheck size={17} /> : <span className="spinner tiny" />}
          </div>
          <div>
            <strong>{ready ? "索引已就绪" : "索引构建中"}</strong>
            <small>
              {ready
                ? `${indexer.entries.toLocaleString()} 个条目`
                : indexer.message ?? "准备自研索引"}
            </small>
          </div>
        </div>
      </div>
    </aside>
  );
}
