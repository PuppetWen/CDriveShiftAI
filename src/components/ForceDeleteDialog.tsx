import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Cpu,
  FileWarning,
  FolderX,
  LoaderCircle,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
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
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .previewForceDelete(path)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((reason) => {
        if (active) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(
            message.includes("受保护路径")
              ? ui("该路径受系统保护，不能强制删除", "This path is system-protected and cannot be force deleted")
              : message.includes("CDriveShiftAI 当前程序")
                ? ui("不能删除 CDriveShiftAI 当前程序或数据所在目录", "The active CDriveShiftAI program or data directory cannot be deleted")
                : message
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, ui]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onClose]);

  const execute = async () => {
    if (!preview || !confirmed || deleting) return;
    setDeleting(true);
    setError("");
    try {
      const result = await api.executeForceDelete(preview.verificationId);
      if (!result.deleted) throw new Error(ui("强制删除未完成", "Force deletion did not complete"));
      onDeleted(preview.path);
      notify(
        "success",
        result.terminatedProcesses.length > 0
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
          ? ui("删除预检已过期，请关闭窗口后重新操作", "The deletion preview expired. Close this dialog and try again")
          : message.includes("管理员身份") || message.includes("权限不足")
            ? ui("无法结束占用进程或权限不足，请以管理员身份运行后重试", "A related process could not be stopped or access was denied. Run as administrator and try again")
            : message
      );
    } finally {
      setDeleting(false);
    }
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

          {error && !preview && (
            <div className="force-delete-error">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          )}

          {preview && (
            <>
              <div className="force-delete-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>{ui("目标不会进入回收站", "The target will not go to the Recycle Bin")}</strong>
                  <span>{ui(
                    "删除前会强制结束从该路径启动、或命令行直接引用该路径的相关进程，然后清除只读属性并重试删除。",
                    "Before deletion, processes launched from this path or directly referencing it on their command line will be forcibly stopped. Read-only attributes are then cleared before retrying deletion."
                  )}</span>
                </div>
              </div>

              {(preview.highRisk || !preview.elevated) && (
                <div className="force-delete-risk-flags">
                  {preview.highRisk && <span><ShieldAlert size={13} />{ui("应用安装目录：删除后程序可能无法运行", "Application directory: deleting it may break the app")}</span>}
                  {!preview.elevated && <span><ShieldAlert size={13} />{ui("当前不是管理员权限，部分进程可能无法结束", "Not running as administrator; some processes may not be stoppable")}</span>}
                </div>
              )}

              <section className="force-delete-processes">
                <header>
                  <div><Cpu size={16} /><strong>{ui("相关进程", "Related processes")}</strong></div>
                  <span>{preview.processes.length}</span>
                </header>
                {preview.processes.length === 0 ? (
                  <p>{ui("未发现从目标路径启动或直接引用目标路径的进程。", "No process launched from or directly referencing the target path was found.")}</p>
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
                        <em>{processItem.canTerminate ? ui("将结束", "Will stop") : ui("系统进程，不结束", "Protected")}</em>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <label className="force-delete-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={deleting}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>{ui("我确认永久删除当前选中的这一项，并同意结束上方列出的相关进程。", "I confirm permanent deletion of this selected item and agree to stop the related processes listed above.")}</span>
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
          <span>{ui("普通删除仍可使用右键菜单中的“删除到回收站”", "Normal deletion remains available as “Move to Recycle Bin”")}</span>
          <div>
            <button type="button" onClick={onClose} disabled={deleting}>{ui("取消", "Cancel")}</button>
            <button
              type="button"
              className="danger"
              disabled={!preview || !confirmed || deleting}
              onClick={() => void execute()}
            >
              {deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              {deleting ? ui("正在结束进程并删除…", "Stopping processes and deleting…") : ui("强制永久删除", "Force delete")}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}
