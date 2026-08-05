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
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AppUpdateInfo, IndexerStatus, ViewId } from "../types";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { ThemedTooltip } from "./ThemedTooltip";

const items: Array<{ id: ViewId; label: TranslationKey; icon: LucideIcon }> = [
  { id: "overview", label: "nav.overview", icon: LayoutDashboard },
  { id: "search", label: "nav.search", icon: Search },
  { id: "ownership-map", label: "nav.ownership", icon: Map },
  { id: "analyze", label: "nav.analyze", icon: ScanSearch },
  { id: "migrate", label: "nav.migrate", icon: ArrowRightLeft },
  { id: "history", label: "nav.history", icon: History }
];

interface SidebarProps {
  active: ViewId;
  onChange: (view: ViewId) => void;
  indexer: IndexerStatus;
  collapsed: boolean;
  width: number;
  onToggle: () => void;
  onResize: (width: number, collapsed: boolean, commit: boolean) => void;
  updateInfo?: AppUpdateInfo;
}

export function Sidebar({
  active,
  onChange,
  indexer,
  collapsed,
  width,
  onToggle,
  onResize,
  updateInfo
}: SidebarProps) {
  const { t, formatNumber, direction } = useI18n();
  const [resizing, setResizing] = useState(false);
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    collapsed: boolean;
  } | undefined>(undefined);
  const ready = indexer.state === "ready";
  const updateStatus = updateInfo?.updateAvailable
    ? "available"
    : updateInfo?.status ?? "checking";
  const updateTooltip =
    updateStatus === "available"
      ? updateInfo?.status === "unavailable"
        ? t("sidebar.updateStale", { latest: updateInfo?.latestVersion ?? t("general.unknown") })
        : t("sidebar.updateAvailable", {
            latest: updateInfo?.latestVersion ?? t("general.unknown"),
            current: updateInfo?.currentVersion ?? t("general.unknown")
          })
      : updateStatus === "unavailable"
        ? t("sidebar.updateUnavailable", { message: updateInfo?.message ?? "—" })
        : updateStatus === "current"
          ? t("sidebar.updateCurrent", { current: updateInfo?.currentVersion ?? t("general.unknown") })
          : t("sidebar.updateChecking");

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    resizeState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: collapsed ? 72 : width,
      width,
      collapsed
    };
  };

  const continueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const physicalDelta = event.clientX - state.startX;
    const requested = state.startWidth + (direction === "rtl" ? -physicalDelta : physicalDelta);
    const nextCollapsed = requested < 145;
    const nextWidth = Math.max(190, Math.min(360, requested));
    const shell = event.currentTarget.closest<HTMLElement>(".app-shell");
    shell?.style.setProperty("--sidebar-width", `${Math.round(nextWidth)}px`);
    if (nextCollapsed !== state.collapsed) {
      onResize(nextWidth, nextCollapsed, false);
    }
    state.width = nextWidth;
    state.collapsed = nextCollapsed;
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeState.current = undefined;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResize(state.width, state.collapsed, true);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      onResize(width, true, true);
      return;
    }
    if (event.key === "End") {
      onResize(360, false, true);
      return;
    }
    const physicalStep = event.key === "ArrowRight" ? 12 : -12;
    const step = direction === "rtl" ? -physicalStep : physicalStep;
    const base = collapsed ? 132 : width;
    onResize(base + step, false, true);
  };

  return (
    <aside className={`${collapsed ? "sidebar collapsed" : "sidebar"}${resizing ? " resizing" : ""}`}>
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
          <small>{t("app.tagline")}</small>
        </div>
        <button
          type="button"
          className="sidebar-collapse-button"
          title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="side-nav" aria-label={t("sidebar.mainNavigation")}>
        <span className="nav-caption">{t("nav.workbench")}</span>
        {items.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            className={active === id ? "nav-item active" : "nav-item"}
            onClick={() => onChange(id)}
            title={collapsed ? t(label) : undefined}
            key={id}
          >
            <Icon size={18} />
            <span>{t(label)}</span>
            {active === id && <i />}
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={active === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => onChange("settings")}
          title={collapsed ? t("nav.settings") : undefined}
        >
          <Settings2 size={18} />
          <span>{t("nav.settings")}</span>
          {active === "settings" && <i />}
        </button>
        <div className={`index-mini ${ready ? "is-ready" : ""}`}>
          <div className="index-mini-icon">
            {ready ? <ShieldCheck size={17} /> : <span className="spinner tiny" />}
          </div>
          <div>
            <strong>{ready ? t("sidebar.indexReady") : t("sidebar.indexBuilding")}</strong>
            <small>
              {ready
                ? t("sidebar.entries", { count: formatNumber(indexer.entries) })
                : t("sidebar.indexPreparing")}
            </small>
          </div>
        </div>
      </div>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={72}
        aria-valuemax={360}
        aria-valuenow={collapsed ? 72 : width}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => onResize(238, false, true)}
      />
    </aside>
  );
}
