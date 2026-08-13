import { useEffect, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  FolderInput,
  FolderOpen,
  Link2,
  LockKeyhole,
  SearchCheck,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { MigrationRecord, PreflightResult } from "../types";
import { Badge, EmptyState, PageTitle } from "../components/ui";

interface MigrateViewProps {
  initialPath: string;
  notify: (type: "success" | "error", message: string) => void;
  onCompleted: () => Promise<void>;
  onAnalyze: (path: string) => void;
}

const stageOrder = ["copying", "verifying", "switching", "linked"] as const;

export function MigrateView({
  initialPath,
  notify,
  onCompleted,
  onAnalyze
}: MigrateViewProps) {
  const { t, ui, runtimeText, formatNumber, formatDate } = useI18n();
  const [source, setSource] = useState(initialPath);
  const [destination, setDestination] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult>();
  const [checking, setChecking] = useState(false);
  const [record, setRecord] = useState<MigrationRecord>();
  const [progressMessage, setProgressMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [acceptStaleAnalysis, setAcceptStaleAnalysis] = useState(false);

  useEffect(() => {
    if (initialPath) setSource(initialPath);
  }, [initialPath]);

  useEffect(
    () =>
      api.onMigrationProgress((event) => {
        setRecord(event.record);
        setProgressMessage(runtimeText(event.message));
      }),
    [runtimeText]
  );

  const browse = async (kind: "source" | "destination") => {
    const selected = await api.chooseDirectory(
      kind === "source"
        ? ui("选择任意磁盘的源目录", "Choose a source directory on any drive")
        : ui("选择目标磁盘目录", "Choose a destination directory"),
      kind === "source" ? "migration-source" : "migration-destination"
    );
    if (!selected) return;
    if (kind === "source") setSource(selected);
    else setDestination(selected);
    setPreflight(undefined);
    setConsent(false);
    setAcceptStaleAnalysis(false);
  };

  const check = async () => {
    if (!source || !destination) {
      notify("error", ui("请先选择源目录和目标目录", "Choose both a source and a destination directory"));
      return;
    }
    setChecking(true);
    try {
      const value = await api.preflightMigration(source, destination);
      setPreflight(value);
      setConsent(false);
      setAcceptStaleAnalysis(false);
      if (value.allowed) notify("success", ui("预检通过，可以进入安全迁移", "Preflight passed; safe migration is ready"));
      else notify("error", runtimeText(value.blockers[0]) || ui("预检未通过", "Preflight did not pass"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  const execute = async () => {
    if (!preflight?.allowed || !consent) return;
    setRunning(true);
    try {
      const completed = await api.executeMigration(source, destination);
      setRecord(completed);
      notify("success", ui(`已释放 ${formatBytes(completed.totalBytes)} 原磁盘空间`, `Released ${formatBytes(completed.totalBytes)} on the source drive`));
      await onCompleted();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const activeStage = record
    ? stageOrder.indexOf(record.stage as (typeof stageOrder)[number])
    : -1;
  const progressPercent =
    record?.stage === "linked"
      ? 100
      : activeStage >= 0
        ? ((activeStage + 0.45) / stageOrder.length) * 100
        : 0;

  return (
    <div className="page migrate-page">
      <PageTitle
        eyebrow="TRANSACTIONAL MOVE"
        title={t("page.migrateTitle")}
        description={t("page.migrateDescription")}
        action={
          <Badge tone="good">
            <ShieldCheck size={13} /> {ui("安全事务", "Safe transaction")}
          </Badge>
        }
      />

      <section className="migration-paths glass-card">
        <div className="migration-path-column">
          <div className="path-label">
            <span className="number">01</span>
            <div>
              <strong>{ui("源目录", "Source directory")}</strong>
              <small>{ui("选择希望释放空间的文件夹", "Choose the folder whose drive space you want to free")}</small>
            </div>
          </div>
          <div className="path-input">
            <FolderOpen size={18} />
            <input
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setPreflight(undefined);
                setConsent(false);
                setAcceptStaleAnalysis(false);
              }}
              placeholder={ui("任意盘符:\\路径\\需要迁移的目录", "Any drive:\\path\\directory to migrate")}
            />
            <button type="button" onClick={() => void browse("source")}>
              {ui("浏览", "Browse")}
            </button>
          </div>
        </div>
        <div className="transfer-mark">
          <ArrowRight size={20} />
          <span />
        </div>
        <div className="migration-path-column">
          <div className="path-label">
            <span className="number">02</span>
            <div>
              <strong>{ui("目标基础目录", "Destination base directory")}</strong>
              <small>{ui("必须与源目录位于不同磁盘", "Must be on a different drive from the source")}</small>
            </div>
          </div>
          <div className="path-input">
            <FolderInput size={18} />
            <input
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                setPreflight(undefined);
                setConsent(false);
                setAcceptStaleAnalysis(false);
              }}
              placeholder="D:\Data"
            />
            <button type="button" onClick={() => void browse("destination")}>
              {ui("浏览", "Browse")}
            </button>
          </div>
        </div>
        <button
          className="primary-button check-button"
          type="button"
          disabled={checking || running}
          onClick={() => void check()}
        >
          {checking ? <span className="spinner light" /> : <SearchCheck size={17} />}
          {checking ? ui("正在完整预检…", "Running full preflight…") : ui("执行迁移预检", "Run migration preflight")}
        </button>
      </section>

      {!preflight && !record ? (
        <section className="safety-flow">
          {[
            { icon: Copy, title: ui("复制", "Copy"), text: ui("多线程复制到临时目标", "Copy to a temporary destination in parallel") },
            { icon: SearchCheck, title: ui("校验", "Verify"), text: ui("核对文件数、目录数和字节数", "Verify file count, directory count, and bytes") },
            { icon: ArrowRightLeft, title: ui("切换", "Switch"), text: ui("同目录原子重命名，避免空窗", "Atomically rename in place to avoid downtime") },
            { icon: Link2, title: ui("链接", "Link"), text: ui("原路径透明指向新位置", "Keep the original path pointing to the new location") }
          ].map(({ icon: Icon, title, text }, index) => (
            <div className="flow-step glass-card" key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <Icon size={22} />
              <strong>{title}</strong>
              <small>{text}</small>
            </div>
          ))}
        </section>
      ) : preflight && !preflight.allowed ? (
        <section className="preflight-blocked glass-card">
          <div className="blocked-icon">
            <LockKeyhole size={28} />
          </div>
          <div>
            <h2>{ui("当前配置未通过安全预检", "The current configuration did not pass safety preflight")}</h2>
            <ul>
              {preflight.blockers.map((blocker) => (
                <li key={blocker}>{runtimeText(blocker)}</li>
              ))}
            </ul>
            {preflight.reanalysisRecommended && (
              <div className="analysis-change-actions">
                <p>{runtimeText(preflight.analysisMessage)}</p>
                {preflight.analysisStatus !== "source-missing" && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onAnalyze(source)}
                  >
                    <Sparkles size={15} /> {ui("重新分析目录", "Analyze directory again")}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      ) : preflight ? (
        <section className="preflight-grid">
          <article className="glass-card preflight-summary">
            <div className="card-heading">
              <div>
                <span>PREFLIGHT PASSED</span>
                <h3>{ui("迁移计划", "Migration plan")}</h3>
              </div>
              <CheckCircle2 size={22} className="success-icon" />
            </div>
            <div className="plan-route">
              <div>
                <span>{ui("源", "Source")}</span>
                <strong>{preflight.source}</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>{ui("目标", "Destination")}</span>
                <strong>{preflight.finalDestination}</strong>
              </div>
            </div>
            <div className="plan-metrics">
              <div>
                <span>{ui("将释放", "Space to release")}</span>
                <strong>{formatBytes(preflight.requiredBytes)}</strong>
              </div>
              <div>
                <span>{ui("文件", "Files")}</span>
                <strong>{formatNumber(preflight.fileCount)}</strong>
              </div>
              <div>
                <span>{ui("目录", "Directories")}</span>
                <strong>{formatNumber(preflight.directoryCount)}</strong>
              </div>
              <div>
                <span>{ui("链接", "Links")}</span>
                <strong>{formatNumber(preflight.reparsePointCount)}</strong>
              </div>
              <div>
                <span>{ui("目标可用", "Destination available")}</span>
                <strong>{formatBytes(preflight.availableBytes)}</strong>
              </div>
            </div>

            {record && (
              <div
                className={`migration-live stage-${record.stage}`}
                style={{ "--migration-progress": `${progressPercent}%` } as CSSProperties}
              >
                <div className="migration-live-head">
                  <span>{progressMessage || ui("正在处理", "Processing")}</span>
                  <strong>
                    {record.stage === "linked"
                      ? ui("完成", "Complete")
                      : record.stage === "failed"
                        ? ui("已停止", "Stopped")
                        : ui("进行中", "In progress")}
                  </strong>
                </div>
                <div className="migration-progress-scene" aria-hidden="true">
                  <span />
                  <i>
                    <ArrowRightLeft size={13} />
                  </i>
                  <b />
                </div>
                <div className="live-track">
                  {stageOrder.map((stage, index) => (
                    <div
                      className={index <= activeStage ? "done" : ""}
                      key={stage}
                    >
                      <span>{index < activeStage || record.stage === "linked" ? <Check size={12} /> : index + 1}</span>
                      <small>
                        {stage === "copying"
                          ? ui("复制", "Copy")
                          : stage === "verifying"
                            ? ui("校验", "Verify")
                            : stage === "switching"
                              ? ui("切换", "Switch")
                              : ui("链接", "Link")}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </article>

          <article className="glass-card confirmation-card">
            <div className="card-heading">
              <div>
                <span>CONFIRMATION</span>
                <h3>{ui("最终安全确认", "Final safety confirmation")}</h3>
              </div>
              <LockKeyhole size={19} />
            </div>
            {preflight.reanalysisRecommended && (
              <div className="analysis-change-panel">
                <AlertTriangle size={18} />
                <div>
                  <strong>
                    {preflight.analysisStatus === "changed"
                      ? ui("目录在上次分析后发生了较大变化", "The directory changed substantially since the previous analysis")
                      : ui("缺少可用的已保存分析", "No usable saved analysis is available")}
                  </strong>
                  <p>{runtimeText(preflight.analysisMessage)}</p>
                  {preflight.lastAnalyzedAt && (
                    <small>
                      {ui("上次分析", "Previous analysis")}: {formatDate(preflight.lastAnalyzedAt)}
                    </small>
                  )}
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onAnalyze(source)}
                    >
                      <Sparkles size={14} /> {ui("重新分析", "Analyze again")}
                    </button>
                    <button
                      type="button"
                      className={acceptStaleAnalysis ? "secondary-button active" : "secondary-button"}
                      onClick={() => setAcceptStaleAnalysis(true)}
                    >
                      <Check size={14} /> {ui("仍使用本次预检", "Use this preflight anyway")}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="warning-box">
              <AlertTriangle size={17} />
              <span>{ui("开始前必须完全退出关联应用；程序仍在运行或持续写入时，迁移可能失败或丢失切换瞬间的新写入。应用无法可靠识别所有文件占用。", "Close all related applications before starting. If a program remains active or keeps writing, migration can fail or lose writes made during the switch. The application cannot reliably detect every open file.")}</span>
            </div>
            <ul className="warning-list">
              {preflight.warnings.map((warning) => (
                <li key={warning}>{runtimeText(warning)}</li>
              ))}
            </ul>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                {ui("我已退出关联应用，并理解目标磁盘离线时该目录将不可用。", "I have closed related applications and understand that the directory is unavailable while the destination drive is offline.")}
              </span>
            </label>
            <button
              className="primary-button danger-action full"
              type="button"
              disabled={
                running ||
                record?.stage === "linked" ||
                !consent ||
                (Boolean(preflight.reanalysisRecommended) && !acceptStaleAnalysis)
              }
              onClick={() => void execute()}
            >
              {running ? <span className="spinner light" /> : <ArrowRightLeft size={17} />}
              {record?.stage === "linked"
                ? ui("迁移已完成", "Migration complete")
                : running
                  ? ui("迁移进行中，请勿关闭…", "Migration in progress; do not close the application…")
                  : ui("确认并开始安全迁移", "Confirm and start safe migration")}
            </button>
          </article>
        </section>
      ) : (
        <EmptyState icon={<ArrowRightLeft size={28} />} title={ui("等待迁移计划", "Waiting for a migration plan")}>
          {ui("选择路径并执行预检。", "Choose the paths and run preflight.")}
        </EmptyState>
      )}
    </div>
  );
}
