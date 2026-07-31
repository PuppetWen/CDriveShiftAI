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
        setProgressMessage(event.message);
      }),
    []
  );

  const browse = async (kind: "source" | "destination") => {
    const selected = await api.chooseDirectory(kind === "source" ? "选择任意磁盘的源目录" : "选择目标磁盘目录");
    if (!selected) return;
    if (kind === "source") setSource(selected);
    else setDestination(selected);
    setPreflight(undefined);
    setConsent(false);
    setAcceptStaleAnalysis(false);
  };

  const check = async () => {
    if (!source || !destination) {
      notify("error", "请先选择源目录和目标目录");
      return;
    }
    setChecking(true);
    try {
      const value = await api.preflightMigration(source, destination);
      setPreflight(value);
      setConsent(false);
      setAcceptStaleAnalysis(false);
      if (value.allowed) notify("success", "预检通过，可以进入安全迁移");
      else notify("error", value.blockers[0] ?? "预检未通过");
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
      notify("success", `已释放 ${formatBytes(completed.totalBytes)} 原磁盘空间`);
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
        title="迁走数据，留住原路径。"
        description="完整复制与校验通过后才切换路径；失败会恢复原目录，不做半成品迁移。"
        action={
          <Badge tone="good">
            <ShieldCheck size={13} /> 安全事务
          </Badge>
        }
      />

      <section className="migration-paths glass-card">
        <div className="migration-path-column">
          <div className="path-label">
            <span className="number">01</span>
            <div>
              <strong>源目录</strong>
              <small>选择希望释放空间的文件夹</small>
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
              placeholder="任意盘符:\路径\需要迁移的目录"
            />
            <button type="button" onClick={() => void browse("source")}>
              浏览
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
              <strong>目标基础目录</strong>
              <small>必须与源目录位于不同磁盘</small>
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
              浏览
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
          {checking ? "正在完整预检…" : "执行迁移预检"}
        </button>
      </section>

      {!preflight && !record ? (
        <section className="safety-flow">
          {[
            { icon: Copy, title: "复制", text: "多线程复制到临时目标" },
            { icon: SearchCheck, title: "校验", text: "核对文件数、目录数和字节数" },
            { icon: ArrowRightLeft, title: "切换", text: "同目录原子重命名，避免空窗" },
            { icon: Link2, title: "链接", text: "原路径透明指向新位置" }
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
            <h2>当前配置未通过安全预检</h2>
            <ul>
              {preflight.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
            {preflight.reanalysisRecommended && (
              <div className="analysis-change-actions">
                <p>{preflight.analysisMessage}</p>
                {preflight.analysisStatus !== "source-missing" && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onAnalyze(source)}
                  >
                    <Sparkles size={15} /> 重新分析目录
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
                <h3>迁移计划</h3>
              </div>
              <CheckCircle2 size={22} className="success-icon" />
            </div>
            <div className="plan-route">
              <div>
                <span>源</span>
                <strong>{preflight.source}</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>目标</span>
                <strong>{preflight.finalDestination}</strong>
              </div>
            </div>
            <div className="plan-metrics">
              <div>
                <span>将释放</span>
                <strong>{formatBytes(preflight.requiredBytes)}</strong>
              </div>
              <div>
                <span>文件</span>
                <strong>{preflight.fileCount.toLocaleString()}</strong>
              </div>
              <div>
                <span>目录</span>
                <strong>{preflight.directoryCount.toLocaleString()}</strong>
              </div>
              <div>
                <span>目标可用</span>
                <strong>{formatBytes(preflight.availableBytes)}</strong>
              </div>
            </div>

            {record && (
              <div
                className={`migration-live stage-${record.stage}`}
                style={{ "--migration-progress": `${progressPercent}%` } as CSSProperties}
              >
                <div className="migration-live-head">
                  <span>{progressMessage || "正在处理"}</span>
                  <strong>
                    {record.stage === "linked"
                      ? "完成"
                      : record.stage === "failed"
                        ? "已停止"
                        : "进行中"}
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
                          ? "复制"
                          : stage === "verifying"
                            ? "校验"
                            : stage === "switching"
                              ? "切换"
                              : "链接"}
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
                <h3>最终安全确认</h3>
              </div>
              <LockKeyhole size={19} />
            </div>
            {preflight.reanalysisRecommended && (
              <div className="analysis-change-panel">
                <AlertTriangle size={18} />
                <div>
                  <strong>
                    {preflight.analysisStatus === "changed"
                      ? "目录在上次分析后发生了较大变化"
                      : "缺少可用的已保存分析"}
                  </strong>
                  <p>{preflight.analysisMessage}</p>
                  {preflight.lastAnalyzedAt && (
                    <small>
                      上次分析：{new Date(preflight.lastAnalyzedAt).toLocaleString("zh-CN")}
                    </small>
                  )}
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onAnalyze(source)}
                    >
                      <Sparkles size={14} /> 重新分析
                    </button>
                    <button
                      type="button"
                      className={acceptStaleAnalysis ? "secondary-button active" : "secondary-button"}
                      onClick={() => setAcceptStaleAnalysis(true)}
                    >
                      <Check size={14} /> 仍使用本次预检
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="warning-box">
              <AlertTriangle size={17} />
              <span>开始前请完全退出关联应用。切换成功后，源盘旧副本会删除以实际释放空间。</span>
            </div>
            <ul className="warning-list">
              {preflight.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                我已退出关联应用，并理解目标磁盘离线时该目录将不可用。
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
              {record?.stage === "linked" ? "迁移已完成" : running ? "迁移进行中，请勿关闭…" : "确认并开始安全迁移"}
            </button>
          </article>
        </section>
      ) : (
        <EmptyState icon={<ArrowRightLeft size={28} />} title="等待迁移计划">
          选择路径并执行预检。
        </EmptyState>
      )}
    </div>
  );
}
