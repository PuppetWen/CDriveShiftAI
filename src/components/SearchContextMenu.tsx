import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ArrowRightLeft,
  Clipboard,
  Copy,
  FileInput,
  FileSearch,
  Filter,
  FolderOpen,
  Info,
  Pencil,
  Play,
  Search,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import type { SearchResult } from "../types";

interface SearchContextMenuProps {
  item: SearchResult;
  x: number;
  y: number;
  initialRename?: boolean;
  onClose: () => void;
  onAnalyze: (path: string) => void;
  onMigrate: (path: string) => void;
  onSearchWithin: (path: string, content: boolean) => void;
  onFindSameName: (name: string) => void;
  onFilterExtension: (extension: string) => void;
  onProperties: (path: string) => void;
  onDeleted: (path: string) => void;
  onRenamed: (oldPath: string, newPath: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

function parentPath(value: string): string {
  return value.replace(/[\\/][^\\/]+[\\/]?$/, "");
}

function extensionOf(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLocaleLowerCase() : "";
}

function clampMenuPosition(
  position: { x: number; y: number },
  width = 344,
  height = 205
) {
  return {
    x: Math.max(8, Math.min(position.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(position.y, window.innerHeight - height - 8))
  };
}

let sessionRenamePosition: { x: number; y: number } | undefined;

export function SearchContextMenu({
  item,
  x,
  y,
  initialRename = false,
  onClose,
  onAnalyze,
  onMigrate,
  onSearchWithin,
  onFindSameName,
  onFilterExtension,
  onProperties,
  onDeleted,
  onRenamed,
  notify
}: SearchContextMenuProps) {
  const [renaming, setRenaming] = useState(initialRename);
  const [newName, setNewName] = useState(item.name);
  const [busy, setBusy] = useState("");
  const [position, setPosition] = useState(() =>
    clampMenuPosition({ x, y }, 344, initialRename ? 205 : 620)
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | undefined>(undefined);
  const extension = extensionOf(item.name);

  const restoreRenamePosition = async (fallback: { x: number; y: number }) => {
    const immediate = sessionRenamePosition ?? fallback;
    setPosition(clampMenuPosition(immediate));
    try {
      const layout = await api.getUiLayout();
      setPosition(
        clampMenuPosition(sessionRenamePosition ?? layout.searchRenamePosition ?? fallback)
      );
    } catch {
      setPosition(clampMenuPosition(immediate));
    }
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

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const bounds = menuRef.current?.getBoundingClientRect();
      const next = clampMenuPosition(
        {
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY
        },
        bounds?.width ?? 344,
        bounds?.height ?? 205
      );
      sessionRenamePosition = next;
      setPosition(next);
    };
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = undefined;
      const finalPosition =
        sessionRenamePosition ?? { x: drag.originX, y: drag.originY };
      sessionRenamePosition = finalPosition;
      setPosition(finalPosition);
      void api
        .updateUiLayout({ searchRenamePosition: finalPosition })
        .catch((error) =>
          notify(
            "error",
            `无法保存重命名窗口位置：${error instanceof Error ? error.message : String(error)}`
          )
        );
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", finish, true);
    return () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", finish, true);
    };
  }, [notify]);

  useLayoutEffect(() => {
    if (!renaming) {
      setPosition(clampMenuPosition({ x, y }, 344, 620));
    }
  }, [renaming, x, y]);

  useEffect(() => {
    if (initialRename) {
      void restoreRenamePosition({ x, y });
    }
    // Initial F2 opening only; later transitions use beginRename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginRename = () => {
    setRenaming(true);
    void restoreRenamePosition(position);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      !renaming ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button, input")
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const beginMouseDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (
      !renaming ||
      event.button !== 0 ||
      dragRef.current ||
      (event.target as HTMLElement).closest("button, input")
    ) {
      return;
    }
    dragRef.current = {
      pointerId: -1,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    };
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = menuRef.current?.getBoundingClientRect();
    const next = clampMenuPosition(
      {
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY
      },
      bounds?.width ?? 344,
      bounds?.height ?? 205
    );
    sessionRenamePosition = next;
    setPosition(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const finalPosition = sessionRenamePosition ?? position;
    sessionRenamePosition = finalPosition;
    setPosition(finalPosition);
    void api
      .updateUiLayout({ searchRenamePosition: finalPosition })
      .catch((error) =>
        notify("error", `无法保存重命名窗口位置：${error instanceof Error ? error.message : String(error)}`)
      );
  };

  const run = async (
    label: string,
    operation: () => Promise<void>,
    success?: string,
    close = true
  ) => {
    setBusy(label);
    try {
      await operation();
      if (success) notify("success", success);
      if (close) onClose();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const copyTo = async () => {
    const destination = await api.chooseDirectory("选择复制目标目录");
    if (!destination) return;
    await run(
      "复制到",
      async () => {
        const output = await api.copyPathToDirectory(item.path, destination);
        notify("success", `已复制到 ${output}`);
      },
      undefined
    );
  };

  const renameItem = async () => {
    const value = newName.trim();
    if (!value || value === item.name) {
      setRenaming(false);
      return;
    }
    await run(
      "重命名",
      async () => {
        const output = await api.renamePath(item.path, value);
        onRenamed(item.path, output);
      },
      "重命名完成"
    );
  };

  return createPortal(
    <div
      className="search-context-menu"
      ref={menuRef}
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={`${item.name} 的操作菜单`}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header
        className={`context-target ${renaming ? "draggable" : ""}`}
        onPointerDown={beginDrag}
        onMouseDown={beginMouseDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className={item.isDirectory ? "context-target-icon folder" : "context-target-icon"}>
          {item.isDirectory ? <FolderOpen size={18} /> : <FileInput size={18} />}
        </div>
        <div>
          <strong>{item.name}</strong>
          <span>{item.path}</span>
          <small>
            {renaming
              ? "按住这里拖动 · 松开后自动记住位置"
              : (
                  <>
                    {item.isDirectory ? "文件夹" : extension ? extension.toUpperCase() : "文件"}
                    {" · "}
                    {!item.isDirectory || item.size > 0 ? formatBytes(item.size) : "大小计算中"}
                    {item.modifiedAt ? ` · ${formatDate(item.modifiedAt)}` : ""}
                  </>
                )}
          </small>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭菜单">
          <X size={14} />
        </button>
      </header>

      {renaming ? (
        <div className="context-rename">
          <label>
            <Pencil size={14} />
            重命名
          </label>
          <input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void renameItem();
              if (event.key === "Escape") setRenaming(false);
            }}
          />
          <div>
            <button type="button" onClick={() => setRenaming(false)}>
              取消
            </button>
            <button type="button" className="confirm" onClick={() => void renameItem()}>
              确认
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="context-section">
            <button
              type="button"
              className="context-primary"
              onClick={() =>
                void run("打开", () => api.openPath(item.path))
              }
            >
              <Play size={15} />
              <span>{item.isDirectory ? "打开文件夹" : "使用系统默认方式打开"}</span>
              <kbd>Enter</kbd>
            </button>
            <button
              type="button"
              onClick={() => void run("定位", () => api.revealPath(item.path))}
            >
              <FolderOpen size={15} />
              <span>在文件资源管理器中显示</span>
              <kbd>Ctrl ↵</kbd>
            </button>
            {!item.isDirectory && (
              <button
                type="button"
                onClick={() => void run("打开方式", () => api.openWith(item.path))}
              >
                <AppWindow size={15} />
                <span>选择其他应用打开…</span>
              </button>
            )}
          </div>

          {item.isDirectory && (
            <div className="context-section">
              <button
                type="button"
                onClick={() => {
                  onSearchWithin(item.path, false);
                  onClose();
                }}
              >
                <Search size={15} />
                <span>在此文件夹内搜索名称</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSearchWithin(item.path, true);
                  onClose();
                }}
              >
                <FileSearch size={15} />
                <span>在此文件夹内搜索内容</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onAnalyze(item.path);
                  onClose();
                }}
              >
                <Sparkles size={15} />
                <span>AI 目录归属分析</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onMigrate(item.path);
                  onClose();
                }}
              >
                <ArrowRightLeft size={15} />
                <span>进入安全迁移</span>
              </button>
            </div>
          )}

          <div className="context-section">
            <button
              type="button"
              onClick={() =>
                void run("复制路径", () => api.copyText(item.path), "完整路径已复制")
              }
            >
              <Clipboard size={15} />
              <span>复制完整路径</span>
              <kbd>Ctrl ⇧ C</kbd>
            </button>
            <button
              type="button"
              onClick={() =>
                void run("复制名称", () => api.copyText(item.name), "名称已复制")
              }
            >
              <Copy size={15} />
              <span>复制文件名/文件夹名</span>
            </button>
            <button
              type="button"
              onClick={() =>
                void run("复制父路径", () => api.copyText(parentPath(item.path)), "父路径已复制")
              }
            >
              <Copy size={15} />
              <span>复制父目录路径</span>
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void copyTo()}>
              <FileInput size={15} />
              <span>{busy === "复制到" ? "正在复制…" : "复制到…"}</span>
            </button>
          </div>

          <div className="context-section">
            <button
              type="button"
              onClick={() => {
                onFindSameName(item.name);
                onClose();
              }}
            >
              <Search size={15} />
              <span>查找同名项目</span>
            </button>
            {!item.isDirectory && extension && (
              <button
                type="button"
                onClick={() => {
                  onFilterExtension(extension);
                  onClose();
                }}
              >
                <Filter size={15} />
                <span>只显示 .{extension} 文件</span>
              </button>
            )}
            <button type="button" onClick={beginRename}>
              <Pencil size={15} />
              <span>重命名</span>
              <kbd>F2</kbd>
            </button>
            <button
              type="button"
              onClick={() => {
                onProperties(item.path);
                onClose();
              }}
            >
              <Info size={15} />
              <span>属性</span>
              <kbd>Alt ↵</kbd>
            </button>
          </div>

          <div className="context-section danger-section">
            <button
              type="button"
              className="danger"
              onClick={() =>
                void run(
                  "删除",
                  async () => {
                    const deleted = await api.trashPath(item.path);
                    if (deleted) {
                      onDeleted(item.path);
                      notify("success", "已移入回收站");
                    }
                  },
                  undefined
                )
              }
            >
              <Trash2 size={15} />
              <span>删除到回收站</span>
              <kbd>Delete</kbd>
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
