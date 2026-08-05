import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Clipboard,
  Copy,
  FolderOpen,
  Info,
  Play,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { OwnershipMapEntry } from "../types";

interface OwnershipContextMenuProps {
  entry: OwnershipMapEntry;
  x: number;
  y: number;
  onClose: () => void;
  onAnalyze: (path: string) => void;
  onMigrate: (path: string) => void;
  onProperties: (path: string) => void;
  onDeleted: (path: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

export function OwnershipContextMenu({
  entry,
  x,
  y,
  onClose,
  onAnalyze,
  onMigrate,
  onProperties,
  onDeleted,
  notify
}: OwnershipContextMenuProps) {
  const { ui, formatDate } = useI18n();
  const [busy, setBusy] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const categoryLabels: Record<OwnershipMapEntry["category"], string> = {
    application: ui("应用安装目录", "Application installation"),
    "application-data": ui("应用数据", "Application data"),
    cache: ui("缓存/临时数据", "Cache / temporary data"),
    "user-data": ui("用户数据", "User data"),
    development: ui("开发数据", "Development data"),
    system: ui("系统组件", "System component"),
    unknown: ui("待识别目录", "Unidentified folder")
  };

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keyboard);
    };
  }, [onClose]);

  const run = async (
    label: string,
    operation: () => Promise<void>,
    success?: string
  ) => {
    setBusy(label);
    try {
      await operation();
      if (success) notify("success", success);
      onClose();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div
      className="search-context-menu ownership-context-menu"
      ref={menuRef}
      style={{ left: x, top: y }}
      role="menu"
      aria-label={ui(`${entry.name} 的目录操作菜单`, `Folder actions for ${entry.name}`)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="context-target ownership-context-target">
        <div className={`context-target-icon ownership ${entry.category}`}>
          <ShieldCheck size={18} />
        </div>
        <div>
          <strong>{entry.name}</strong>
          <span>{entry.path}</span>
          <small>
            {categoryLabels[entry.category]}
            {entry.owner ? ` · ${entry.owner.appName}` : ""}
            {entry.lastModified ? ` · ${formatDate(entry.lastModified)}` : ""}
          </small>
        </div>
        <button type="button" onClick={onClose} aria-label={ui("关闭菜单", "Close menu")}>
          <X size={14} />
        </button>
      </header>

      <div className="ownership-context-evidence">
        <span className={`risk ${entry.risk}`}>{entry.risk === "blocked" ? ui("系统保护", "System protected") : ui(`风险 ${entry.risk}`, `Risk: ${entry.risk}`)}</span>
        <strong>
          {entry.owner
            ? ui(`${Math.round(entry.owner.confidence * 100)}% 本地证据匹配`, `${Math.round(entry.owner.confidence * 100)}% local evidence match`)
            : ui("尚未匹配到已安装应用", "No installed application matched")}
        </strong>
        <small>{entry.explanation}</small>
      </div>

      <div className="context-section">
        <button
          type="button"
          className="context-primary"
          disabled={Boolean(busy)}
          onClick={() => void run("open", () => api.openPath(entry.path))}
        >
          <Play size={15} />
          <span>{ui("打开文件夹", "Open folder")}</span>
          <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run("reveal", () => api.revealPath(entry.path))}
        >
          <FolderOpen size={15} />
          <span>{ui("在文件资源管理器中显示", "Show in File Explorer")}</span>
          <kbd>Ctrl ↵</kbd>
        </button>
      </div>

      <div className="context-section">
        <button
          type="button"
          onClick={() => {
            onAnalyze(entry.path);
            onClose();
          }}
        >
          <Sparkles size={15} />
          <span>{ui("详细 AI 目录归属分析", "Detailed AI folder ownership analysis")}</span>
        </button>
        <button
          type="button"
          disabled={entry.risk === "blocked"}
          onClick={() => {
            onMigrate(entry.path);
            onClose();
          }}
        >
          <ArrowRightLeft size={15} />
          <span>{entry.risk === "blocked" ? ui("系统保护目录不可迁移", "System-protected folders cannot be moved") : ui("进入安全迁移", "Open safe migration")}</span>
        </button>
      </div>

      <div className="context-section">
        <button
          type="button"
          onClick={() => void run("copy-path", () => api.copyText(entry.path), ui("完整路径已复制", "Full path copied"))}
        >
          <Clipboard size={15} />
          <span>{ui("复制完整路径", "Copy full path")}</span>
        </button>
        <button
          type="button"
          onClick={() => void run("copy-name", () => api.copyText(entry.name), ui("目录名称已复制", "Folder name copied"))}
        >
          <Copy size={15} />
          <span>{ui("复制目录名称", "Copy folder name")}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onProperties(entry.path);
            onClose();
          }}
        >
          <Info size={15} />
          <span>{ui("目录属性", "Folder properties")}</span>
          <kbd>Alt ↵</kbd>
        </button>
      </div>

      <div className="context-section danger-section">
        <button
          type="button"
          className="danger"
          disabled={entry.risk === "blocked" || Boolean(busy)}
          onClick={() =>
            void run("delete", async () => {
              const deleted = await api.trashPath(entry.path);
              if (deleted) {
                onDeleted(entry.path);
                notify("success", ui("已移入回收站", "Moved to the Recycle Bin"));
              }
            })
          }
        >
          <Trash2 size={15} />
          <span>{entry.risk === "blocked" ? ui("系统保护目录不可删除", "System-protected folders cannot be deleted") : ui("删除到回收站", "Move to Recycle Bin")}</span>
          <kbd>Delete</kbd>
        </button>
      </div>
    </div>
  );
}
