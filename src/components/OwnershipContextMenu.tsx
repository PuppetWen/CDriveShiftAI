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
import { formatDate } from "../lib/format";
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

const categoryLabels: Record<OwnershipMapEntry["category"], string> = {
  application: "应用安装目录",
  "application-data": "应用数据",
  cache: "缓存/临时数据",
  "user-data": "用户数据",
  development: "开发数据",
  system: "系统组件",
  unknown: "待识别目录"
};

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
  const [busy, setBusy] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

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
      aria-label={`${entry.name} 的目录操作菜单`}
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
        <button type="button" onClick={onClose} aria-label="关闭菜单">
          <X size={14} />
        </button>
      </header>

      <div className="ownership-context-evidence">
        <span className={`risk ${entry.risk}`}>{entry.risk === "blocked" ? "系统保护" : `风险 ${entry.risk}`}</span>
        <strong>
          {entry.owner
            ? `${Math.round(entry.owner.confidence * 100)}% 本地证据匹配`
            : "尚未匹配到已安装应用"}
        </strong>
        <small>{entry.explanation}</small>
      </div>

      <div className="context-section">
        <button
          type="button"
          className="context-primary"
          disabled={Boolean(busy)}
          onClick={() => void run("打开", () => api.openPath(entry.path))}
        >
          <Play size={15} />
          <span>打开文件夹</span>
          <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run("定位", () => api.revealPath(entry.path))}
        >
          <FolderOpen size={15} />
          <span>在文件资源管理器中显示</span>
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
          <span>详细 AI 目录归属分析</span>
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
          <span>{entry.risk === "blocked" ? "系统保护目录不可迁移" : "进入安全迁移"}</span>
        </button>
      </div>

      <div className="context-section">
        <button
          type="button"
          onClick={() => void run("复制路径", () => api.copyText(entry.path), "完整路径已复制")}
        >
          <Clipboard size={15} />
          <span>复制完整路径</span>
        </button>
        <button
          type="button"
          onClick={() => void run("复制名称", () => api.copyText(entry.name), "目录名称已复制")}
        >
          <Copy size={15} />
          <span>复制目录名称</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onProperties(entry.path);
            onClose();
          }}
        >
          <Info size={15} />
          <span>目录属性</span>
          <kbd>Alt ↵</kbd>
        </button>
      </div>

      <div className="context-section danger-section">
        <button
          type="button"
          className="danger"
          disabled={entry.risk === "blocked" || Boolean(busy)}
          onClick={() =>
            void run("删除", async () => {
              const deleted = await api.trashPath(entry.path);
              if (deleted) {
                onDeleted(entry.path);
                notify("success", "已移入回收站");
              }
            })
          }
        >
          <Trash2 size={15} />
          <span>{entry.risk === "blocked" ? "系统保护目录不可删除" : "删除到回收站"}</span>
          <kbd>Delete</kbd>
        </button>
      </div>
    </div>
  );
}
