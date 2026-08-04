import {
  ArrowRight,
  ArrowRightLeft,
  Bot,
  Clock3,
  Database,
  FolderSearch,
  HardDrive,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Zap
} from "lucide-react";
import type { AppSettings, MigrationRecord, SystemOverview, ViewId } from "../types";
import { formatBytes, formatDate } from "../lib/format";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, PageTitle, Skeleton } from "../components/ui";

interface OverviewProps {
  overview?: SystemOverview;
  settings?: AppSettings;
  history: MigrationRecord[];
  onNavigate: (view: ViewId) => void;
  notify: (type: "success" | "error", message: string) => void;
}

export function OverviewView({
  overview,
  settings,
  history,
  onNavigate,
  notify
}: OverviewProps) {
  const { feedback, openFromDoubleClick, classNameFor } = usePathOpenFeedback(notify);
  const systemDrive =
    overview?.drives.find((drive) => drive.root.toUpperCase() === "C:\\") ?? overview?.drives[0];
  const usedRatio = systemDrive ? systemDrive.usedBytes / systemDrive.totalBytes : 0;
  const reclaimed = history
    .filter((record) => record.stage === "linked")
    .reduce((sum, record) => sum + record.totalBytes, 0);
  const latest = history.slice(0, 4);

  return (
    <div className="page overview-page">
      <PageTitle
        eyebrow="CONTROL CENTER"
        title="全盘空间，一目了然"
        description="先找数据，再识别归属。CDriveShiftAI 用可恢复事务把目录迁往任意其他磁盘。"
        action={
          <button className="primary-button" type="button" onClick={() => onNavigate("search")}>
            <Search size={17} />
            搜索整个电脑
          </button>
        }
      />

      <section className="hero-grid">
        <article className="drive-hero glass-card">
          <div className="drive-ring-wrap">
            <div
              className="drive-ring"
              style={{ "--used": `${Math.min(100, usedRatio * 100)}%` } as React.CSSProperties}
            >
              <div>
                <HardDrive size={22} />
                <strong>C:</strong>
                <small>{systemDrive?.fileSystem ?? "检测中"}</small>
              </div>
            </div>
          </div>
          <div className="drive-details">
            <div className="card-kicker">
              <span className="live-pulse" />
              系统盘实时状态
            </div>
            {systemDrive ? (
              <>
                <h2>{formatBytes(systemDrive.freeBytes)} 可用</h2>
                <p>
                  已使用 {formatBytes(systemDrive.usedBytes)}，共 {formatBytes(systemDrive.totalBytes)}
                </p>
                <div className="capacity-bar">
                  <span style={{ width: `${Math.min(100, usedRatio * 100)}%` }} />
                </div>
                <div className="capacity-labels">
                  <span>已使用 {Math.round(usedRatio * 100)}%</span>
                  <span>建议保留 15% 以上</span>
                </div>
              </>
            ) : (
              <div className="loading-lines">
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            )}
          </div>
          <div className="drive-ambient" />
        </article>

        <div className="metric-stack">
          <article className="metric-card glass-card">
            <div className="metric-icon mint">
              <Sparkles size={19} />
            </div>
            <div>
              <span>累计释放</span>
              <strong>{formatBytes(reclaimed)}</strong>
              <small>{history.filter((record) => record.stage === "linked").length} 个有效迁移</small>
            </div>
          </article>
          <article className="metric-card glass-card">
            <div className="metric-icon blue">
              <Database size={19} />
            </div>
            <div>
              <span>索引条目</span>
              <strong>{(overview?.indexer.entries ?? 0).toLocaleString()}</strong>
              <small>查询在本机内存中完成</small>
            </div>
          </article>
          <article className="metric-card glass-card">
            <div className="metric-icon purple">
              <Bot size={19} />
            </div>
            <div>
              <span>分析引擎</span>
              <strong>{settings?.ai.enabled ? "本地 + AI" : "本地规则"}</strong>
              <small>{settings?.ai.enabled ? settings.ai.model : "文件名不会离开设备"}</small>
            </div>
          </article>
        </div>
      </section>

      <section className="drive-list-section">
        <div className="section-title compact">
          <div>
            <span>LOCAL DRIVES</span>
            <h2>本机磁盘</h2>
          </div>
          <small>选择任意磁盘搜索、分析；迁移时源盘与目标盘需不同</small>
        </div>
        <div className="drive-strip">
          {overview?.drives.map((drive) => {
            const ratio = drive.totalBytes ? drive.usedBytes / drive.totalBytes : 0;
            return (
              <button className="drive-tile glass-card" type="button" onClick={() => onNavigate("search")} key={drive.root}>
                <div className="drive-tile-icon">
                  <HardDrive size={18} />
                </div>
                <div className="drive-tile-main">
                  <div>
                    <strong>{drive.root}</strong>
                    <span>{drive.fileSystem}</span>
                    <b>{formatBytes(drive.freeBytes)} 可用</b>
                  </div>
                  <i>
                    <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                  </i>
                  <small>
                    {formatBytes(drive.usedBytes)} / {formatBytes(drive.totalBytes)}
                  </small>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="section-block">
        <div className="section-title">
          <div>
            <span>QUICK START</span>
            <h2>从哪里开始？</h2>
          </div>
          <Badge tone="good">
            <ShieldCheck size={13} /> 安全模式已启用
          </Badge>
        </div>
        <div className="action-grid">
          <button className="action-card glass-card" type="button" onClick={() => onNavigate("search")}>
            <div className="action-icon cyan">
              <FolderSearch size={22} />
            </div>
            <div>
              <h3>极速定位大目录</h3>
              <p>走 MFT/持久化索引，输入即得结果。</p>
            </div>
            <ArrowRight size={18} />
          </button>
          <button className="action-card glass-card" type="button" onClick={() => onNavigate("analyze")}>
            <div className="action-icon violet">
              <ScanSearch size={22} />
            </div>
            <div>
              <h3>识别目录归属</h3>
              <p>交叉分析应用、路径与文件特征。</p>
            </div>
            <ArrowRight size={18} />
          </button>
          <button className="action-card glass-card" type="button" onClick={() => onNavigate("migrate")}>
            <div className="action-icon amber">
              <ArrowRightLeft size={22} />
            </div>
            <div>
              <h3>创建安全迁移</h3>
              <p>复制、校验、切换，全程留下事务记录。</p>
            </div>
            <ArrowRight size={18} />
          </button>
        </div>
      </section>

      <section className="dashboard-bottom-grid">
        <article className="glass-card recent-card">
          <div className="section-title compact">
            <div>
              <span>ACTIVITY</span>
              <h2>最近迁移</h2>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate("history")}>
              查看全部 <ArrowRight size={14} />
            </button>
          </div>
          {latest.length === 0 ? (
            <div className="quiet-empty">
              <Clock3 size={22} />
              <div>
                <strong>还没有迁移记录</strong>
                <span>完成第一次安全迁移后会显示在这里。</span>
              </div>
            </div>
          ) : (
            <div className="activity-list">
              {latest.map((record) => (
                <div
                  className={`activity-row path-openable ${classNameFor(record.source)}`}
                  key={record.id}
                  onDoubleClick={(event) => openFromDoubleClick(event, record.source)}
                  title="双击打开源目录"
                >
                  <div className={`activity-icon ${record.stage}`}>
                    <ArrowRightLeft size={16} />
                  </div>
                  <div className="activity-main">
                    <strong>{record.source.split(/[\\/]/).at(-1)}</strong>
                    <span>{record.source}</span>
                  </div>
                  <div className="activity-meta">
                    <strong>{formatBytes(record.totalBytes)}</strong>
                    <span>{formatDate(record.updatedAt)}</span>
                  </div>
                  <PathOpenFeedback path={record.source} feedback={feedback} />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="glass-card principle-card">
          <div className="principle-orbit">
            <ShieldCheck size={30} />
            <span className="orbit one" />
            <span className="orbit two" />
          </div>
          <div>
            <span className="eyebrow">SAFETY FIRST</span>
            <h2>任何时候，都能解释发生了什么。</h2>
            <p>系统路径硬拦截、目标空间余量、逐项校验、崩溃恢复与显式回滚，组成完整保护链。</p>
            <div className="principle-tags">
              <span>
                <Zap size={13} /> 原子切换
              </span>
              <span>
                <ShieldCheck size={13} /> 可恢复
              </span>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}
