import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Cpu,
  Copy,
  ExternalLink,
  FileWarning,
  FolderOpen,
  FolderX,
  LoaderCircle,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { forceDeleteGuidance, SAFE_MODE_HELP_URL } from "../lib/force-delete-guidance";
import type { ForceDeletePreview } from "../types";

interface ForceDeleteDialogProps {
  path: string;
  onClose: () => void;
  onDeleted: (path: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

export function ForceDeleteDialog({
  path,
  onClose,
  onDeleted,
  notify
}: ForceDeleteDialogProps) {
  const { ui } = useI18n();
  const [preview, setPreview] = useState<ForceDeletePreview>();
  const [lastPreview, setLastPreview] = useState<ForceDeletePreview>();
  const [previewForPath, setPreviewForPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [previewRequest, setPreviewRequest] = useState(0);
  const deletingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPreview(undefined);
    setLastPreview(undefined);
    setConfirmed(false);
    void api
      .previewForceDelete(path)
      .then((value) => {
        if (active) {
          setPreview(value);
          setLastPreview(value);
          setPreviewForPath(path);
        }
      })
      .catch((reason) => {
        if (active) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, previewRequest, ui]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onClose]);

  const execute = async () => {
    if (!preview || previewForPath !== path || !confirmed || deletingRef.current || loading) return;
    deletingRef.current = true;
    setDeleting(true);
    setError("");
    try {
      const result = await api.executeForceDelete(preview.verificationId);
      if (!result.deleted) throw new Error(ui("强制删除未完成", "Force deletion did not complete"));
      onDeleted(preview.path);
      notify(
        "success",
        result.usedElevation
          ? ui("已通过管理员权限处理并永久删除目标", "Target processed with administrator access and permanently deleted")
          : result.terminatedProcesses.length > 0
          ? ui(
              `已结束 ${result.terminatedProcesses.length} 个相关进程并永久删除目标`,
              `Stopped ${result.terminatedProcesses.length} related process(es) and permanently deleted the target`
            )
          : ui("目标已永久删除", "Target permanently deleted")
      );
      onClose();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(
        message.includes("确认已过期")
          ? ui("删除预检已过期，请重新检查后确认", "The deletion preview expired. Check again and confirm the new preview")
          : message
      );
      // Execution consumes its one-use verification token, including failures.
      // A retry must show a fresh preview and require a fresh confirmation.
      setPreview(undefined);
      setConfirmed(false);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const guidance = error ? forceDeleteGuidance(error, lastPreview, ui) : undefined;
  const confirmationDisabled = deleting || loading || previewForPath !== path;
  const status = deleting
    ? ui("正在执行删除，请稍候。若出现系统授权窗口，请完成 UAC 授权。", "Deleting, please wait. Complete UAC if Windows requests authorization.")
    : loading
    ? ui("检查完成后，请勾选确认框。", "Check the confirmation box after the preview is ready.")
    : !preview || previewForPath !== path
    ? ui("请先处理上方提示并重新检查。", "Follow the guidance above and check again.")
    : confirmed
    ? ui("已勾选确认；点击“强制永久删除”开始。", "Confirmed. Click Force delete to begin.")
    : ui("请先勾选上方确认框，再点击“强制永久删除”。", "Check the confirmation box above, then click Force delete.");
  const runHelper = async (operation: () => Promise<unknown>) => {
    try { await operation(); }
    catch (reason) { notify("error", reason instanceof Error ? reason.message : String(reason)); }
  };

  return createPortal(
    <div
      className="force-delete-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onClose();
      }}
    >
      <section
        className="force-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="force-delete-title"
      >
        <header>
          <div className="force-delete-title-icon"><ShieldAlert size={22} /></div>
          <div>
            <small>{ui("不可恢复操作", "IRREVERSIBLE ACTION")}</small>
            <h2 id="force-delete-title">{ui("强制永久删除", "Force permanent deletion")}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={deleting} aria-label={ui("关闭", "Close")}>
            <X size={17} />
          </button>
        </header>

        <div className="force-delete-body">
          <div className="force-delete-target">
            {preview?.isDirectory ? <FolderX size={20} /> : <FileWarning size={20} />}
            <div>
              <strong>{preview?.name ?? path.split(/[\\/]/).pop() ?? path}</strong>
              <span>{preview?.path ?? path}</span>
            </div>
          </div>

          {loading && (
            <div className="force-delete-state">
              <LoaderCircle className="spin" size={24} />
              <strong>{ui("正在检查占用进程和路径风险…", "Checking related processes and path risk…")}</strong>
            </div>
          )}

          {guidance && (
            <section className="force-delete-guidance" aria-labelledby="force-delete-guidance-title" data-reason={guidance.category}>
              <h3 id="force-delete-guidance-title" role="alert"><AlertTriangle size={18} />{guidance.title}</h3>
              {guidance.showRestartHelp && <p className="force-delete-help-intro">{ui("管理员权限也无法解除所有文件锁、驱动占用或访问权限限制。请依次处理；仍失败时展开下方的重启和安全模式说明。", "Administrator access cannot remove every file lock, driver lock, or access restriction. Follow these steps in order; if deletion still fails, expand the restart and Safe Mode instructions below.")}</p>}
              <ol>{guidance.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              {guidance.showTaskManager && Boolean(lastPreview?.processes.length) && (
                <p className="force-delete-last-processes">
                  {ui("上次检查发现（处理后请重新检查）", "Found in the last check (check again after taking action)")}: {lastPreview!.processes.map((item) => `${item.name} · PID ${item.pid}${item.canTerminate ? "" : ui("（受保护，不结束）", " (protected, do not end)")}`).join("；")}
                </p>
              )}
              <div className="force-delete-help-actions">
                <button type="button" onClick={() => void runHelper(() => api.revealPath(path))}><FolderOpen size={14} />{ui("定位文件", "Locate file")}</button>
                <button type="button" onClick={() => void runHelper(async () => { await api.copyText(path); notify("success", ui("路径已复制", "Path copied")); })}><Copy size={14} />{ui("复制路径", "Copy path")}</button>
                {guidance.showTaskManager && <button type="button" onClick={() => void runHelper(() => api.openDeleteHelper("task-manager"))}><Cpu size={14} />{ui("打开任务管理器", "Open Task Manager")}</button>}
                {guidance.showUninstall && <button type="button" onClick={() => void runHelper(() => api.openDeleteHelper("installed-apps"))}><ExternalLink size={14} />{ui("打开已安装的应用", "Open installed apps")}</button>}
                {guidance.category === "migration" && <button type="button" onClick={() => void runHelper(async () => { await api.navigateApp({ view: "history" }); onClose(); })}>{ui("查看迁移历史", "Open migration history")}</button>}
              </div>
              {guidance.showRestartHelp && (
                <details className="force-delete-advanced-help">
                  <summary>{ui("按上述步骤处理后仍不能删除？", "Still unable to delete after these steps?")}</summary>
                  <ol>
                    <li>{ui("先保存工作，选择 Windows“开始 → 电源 → 重启”。重新登录后先不要启动关联应用，直接重新选择目标并检查。", "Save your work, then choose Windows Start → Power → Restart. After signing in, check the target before reopening its app.")}</li>
                    <li>{ui("若应用服务自动启动或目录持续重建，先用“已安装的应用”卸载对应程序，或使用厂商提供的卸载工具；不要直接强杀系统服务或删除驱动文件。", "If its service starts automatically or recreates the folder, uninstall the app through Installed apps or its vendor's uninstaller. Do not forcibly stop system services or delete driver files.")}</li>
                    <li>{ui("对于确认不再需要的普通残留文件，可按微软说明进入安全模式：按住 Shift 点击“重启”，再选择“疑难解答 → 高级选项 → 启动设置 → 重启 → 4/F4”。设备加密时先准备 BitLocker 恢复密钥。", "For ordinary leftover files you no longer need, follow Microsoft's Safe Mode instructions: hold Shift while choosing Restart, then Troubleshoot → Advanced options → Startup Settings → Restart → 4/F4. Have the BitLocker recovery key ready if the device is encrypted.")}</li>
                    <li>{ui("进入安全模式后，在资源管理器中定位已复制的完整路径，再删除普通残留文件；完成后正常重启。仍被拒绝访问时联系文件所有者、设备管理员或软件厂商，安全模式不会授予缺失的文件权限。", "In Safe Mode, use Explorer to locate the copied full path and remove the ordinary leftover files, then restart normally. If access is still denied, contact the owner, administrator, or vendor; Safe Mode does not grant missing file permissions.")}</li>
                  </ol>
                  <div className="force-delete-help-actions">
                    {!guidance.showUninstall && <button type="button" onClick={() => void runHelper(() => api.openDeleteHelper("installed-apps"))}><ExternalLink size={14} />{ui("打开已安装的应用", "Open installed apps")}</button>}
                    <button type="button" onClick={() => void runHelper(() => api.openExternal(SAFE_MODE_HELP_URL))}><ExternalLink size={14} />{ui("微软安全模式说明", "Microsoft Safe Mode guide")}</button>
                  </div>
                </details>
              )}
              <details className="force-delete-error-details">
                <summary>{ui("查看失败原因与路径", "View error details and path")}</summary>
                <div className="force-delete-error"><FileWarning size={16} /><span>{error}</span></div>
              </details>
            </section>
          )}

          {preview && (
            <>
              <div className="force-delete-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>{ui("目标不会进入回收站", "The target will not go to the Recycle Bin")}</strong>
                  <span>{ui(
                    "会先尝试删除；失败且有必要时，结束本次预检列出且身份未变化的进程，再重试。仍失败时会尝试管理员 PowerShell，使用管理员删除权限处理所选目标及其内容，并检查是否删除成功。",
                    "Deletion is attempted first. If needed after a failure, the unchanged processes listed here are stopped before retrying. If it still fails, administrator PowerShell retries with administrator deletion privileges for the selected target and its contents, then verifies the result."
                  )}</span>
                </div>
              </div>

              {(preview.highRisk || !preview.elevated) && (
                <div className="force-delete-risk-flags">
                  {preview.highRisk && <span><ShieldAlert size={13} />{ui("应用安装目录：删除后程序可能无法运行", "Application directory: deleting it may break the app")}</span>}
                  {!preview.elevated && <span><ShieldAlert size={13} />{ui("必要时系统会请求管理员授权（UAC），请核对后允许", "Windows may request administrator authorization (UAC); review it before allowing")}</span>}
                </div>
              )}

              <section className="force-delete-processes">
                <header>
                  <div><Cpu size={16} /><strong>{ui("相关进程", "Related processes")}</strong></div>
                  <span>{preview.processes.length}</span>
                </header>
                <p>{ui("检查文件和目录占用、启动路径与命令行；部分驱动层面的锁定等情况可能无法识别。", "Checks open file and directory handles, executable paths, and command lines. Some driver-level locks may not be detected.")}</p>
                {preview.processWarnings?.map((warning) => <p key={warning}>{warning}</p>)}
                {preview.processes.length === 0 ? (
                  <p>{ui("未发现可识别的目标占用进程。", "No identifiable process using the target was found.")}</p>
                ) : (
                  <div className="force-delete-process-list">
                    {preview.processes.map((processItem) => (
                      <article key={processItem.pid} className={!processItem.canTerminate ? "protected" : ""}>
                        <Cpu size={15} />
                        <div>
                          <strong>{processItem.name}</strong>
                          <span>{processItem.executablePath ?? ui("进程路径不可读", "Process path unavailable")}</span>
                        </div>
                        <small>PID {processItem.pid}</small>
                        <em>{processItem.canTerminate ? ui("必要时结束", "Stop if needed") : ui("系统进程，不结束", "Protected")}</em>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <label
                className="force-delete-confirmation"
                data-confirmed={confirmed}
                aria-disabled={confirmationDisabled}
              >
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={confirmationDisabled}
                  aria-describedby="force-delete-status"
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span className="force-delete-confirmation-copy">
                  <strong>{confirmed
                    ? ui("已勾选确认", "Confirmation checked")
                    : ui("点击勾选，确认永久删除", "Check to confirm permanent deletion")}</strong>
                  <span>{ui("我确认永久删除当前选中的这一项，并同意必要时结束上方进程、通过管理员 PowerShell 重试删除。", "I confirm permanent deletion of this selected item and allow the listed processes to be stopped and administrator PowerShell to retry deletion if needed.")}</span>
                </span>
              </label>
            </>
          )}

          {error && preview && (
            <div className="force-delete-error">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <footer>
          <span id="force-delete-status" role="status">{status}</span>
          <div>
            <button type="button" onClick={onClose} disabled={deleting}>{ui("取消", "Cancel")}</button>
            <button
              type="button"
              className="danger"
              disabled={!preview || previewForPath !== path || !confirmed || deleting || loading}
              aria-describedby="force-delete-status"
              onClick={() => void execute()}
            >
              {deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              {deleting ? ui("正在删除或等待系统授权…", "Deleting or waiting for authorization…") : ui("强制永久删除", "Force delete")}
            </button>
            {!loading && !preview && error && guidance?.canRetry && (
              <button type="button" disabled={deleting} onClick={() => setPreviewRequest((value) => value + 1)}>
                {ui("重新检查", "Check again")}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}
