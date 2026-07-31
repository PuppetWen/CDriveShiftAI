import {
  CalendarClock,
  Check,
  Clipboard,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Link2,
  LockKeyhole,
  MousePointer2,
  Pencil,
  Ruler,
  X
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import type { PathProperties } from "../types";

interface PathPropertiesDialogProps {
  path: string;
  onClose: () => void;
  onRenamed?: (oldPath: string, newPath: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

const dialogWidth = 720;
const dialogHeight = 570;

function centeredPosition() {
  return {
    x: Math.max(12, (window.innerWidth - dialogWidth) / 2),
    y: Math.max(12, (window.innerHeight - dialogHeight) / 2)
  };
}

function clampPosition(position: { x: number; y: number }) {
  return {
    x: Math.max(12, Math.min(position.x, window.innerWidth - dialogWidth - 12)),
    y: Math.max(12, Math.min(position.y, window.innerHeight - 86))
  };
}

function propertyType(value: PathProperties) {
  if (value.isSymbolicLink) {
    return value.isDirectory ? "目录符号链接" : "文件符号链接";
  }
  if (value.isDirectory) return "文件夹";
  return value.extension ? `${value.extension.toUpperCase()} 文件` : "文件";
}

function DateValue({ value }: { value?: string }) {
  return <span>{value ? formatDate(value) : "无可用记录"}</span>;
}

export function PathPropertiesDialog({
  path,
  onClose,
  onRenamed,
  notify
}: PathPropertiesDialogProps) {
  const [activePath, setActivePath] = useState(path);
  const [properties, setProperties] = useState<PathProperties>();
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [position, setPosition] = useState(centeredPosition);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | undefined>(undefined);

  useEffect(() => {
    setActivePath(path);
    setRenaming(false);
  }, [path]);

  useEffect(() => {
    let active = true;
    setProperties(undefined);
    setError("");
    void api.getPathProperties(activePath).then(
      (next) => {
        if (active) {
          setProperties(next);
          setNewName(next.name);
        }
      },
      (reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    );
    return () => {
      active = false;
    };
  }, [activePath]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [onClose]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition(
        clampPosition({
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY
        })
      );
    };
    const finish = () => {
      dragRef.current = undefined;
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", finish, true);
    return () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", finish, true);
    };
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
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
      event.button !== 0 ||
      dragRef.current ||
      (event.target as HTMLElement).closest("button")
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
    setPosition(
      clampPosition({
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY
      })
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const copyPath = async () => {
    try {
      await api.copyText(activePath);
      notify("success", "完整路径已复制");
    } catch (reason) {
      notify("error", reason instanceof Error ? reason.message : String(reason));
    }
  };

  const renameItem = async () => {
    if (!properties || renameBusy) return;
    const requestedName = newName.trim();
    if (!requestedName) {
      notify("error", "名称不能为空");
      return;
    }
    if (requestedName === properties.name) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      const oldPath = activePath;
      const renamedPath = await api.renamePath(oldPath, requestedName);
      setActivePath(renamedPath);
      setRenaming(false);
      onRenamed?.(oldPath, renamedPath);
      notify("success", "重命名完成");
    } catch (reason) {
      notify("error", reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRenameBusy(false);
    }
  };

  return createPortal(
    <div
      className="path-properties-backdrop"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        className="path-properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${properties?.name ?? activePath} 的属性`}
        style={{ left: position.x, top: position.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className="path-properties-titlebar"
          onPointerDown={beginDrag}
          onMouseDown={beginMouseDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="path-properties-title-icon">
            {properties?.isSymbolicLink ? (
              <Link2 size={22} />
            ) : properties?.isDirectory ? (
              <Folder size={22} />
            ) : (
              <File size={22} />
            )}
          </div>
          <div>
            <span>项目属性</span>
            <strong>{properties?.name ?? "正在读取…"}</strong>
          </div>
          <div className="path-properties-drag-hint">
            <MousePointer2 size={12} />
            拖动窗口
          </div>
          <button type="button" onClick={onClose} aria-label="关闭属性窗口">
            <X size={18} />
          </button>
        </header>

        <div className="path-properties-body">
          {error ? (
            <div className="path-properties-error">
              <LockKeyhole size={28} />
              <strong>无法读取该项目</strong>
              <span>{error}</span>
            </div>
          ) : !properties ? (
            <div className="path-properties-loading">
              <i />
              <strong>正在读取文件系统信息</strong>
              <span>大型目录的容量与项目数量统计可能需要一点时间。</span>
            </div>
          ) : (
            <>
              <div className="path-properties-path">
                <FolderOpen size={16} />
                <span>{properties.path}</span>
                <button type="button" onClick={() => void copyPath()}>
                  <Clipboard size={14} />
                  复制
                </button>
              </div>
              {renaming && (
                <div className="path-properties-rename">
                  <Pencil size={15} />
                  <label htmlFor="path-properties-rename-input">重命名</label>
                  <input
                    id="path-properties-rename-input"
                    autoFocus
                    value={newName}
                    maxLength={255}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void renameItem();
                      if (event.key === "Escape") setRenaming(false);
                    }}
                  />
                  <button type="button" onClick={() => setRenaming(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="confirm"
                    disabled={renameBusy}
                    onClick={() => void renameItem()}
                  >
                    {renameBusy ? "处理中…" : "确认"}
                  </button>
                </div>
              )}

              <div className="path-properties-metrics">
                <article>
                  <Ruler size={18} />
                  <span>大小</span>
                  <strong>{formatBytes(properties.size)}</strong>
                  <small>
                    {properties.scanComplete ? "统计完成" : "受时间或权限限制，为当前可读大小"}
                  </small>
                </article>
                <article>
                  <HardDrive size={18} />
                  <span>{properties.isDirectory ? "所含项目" : "占用空间"}</span>
                  <strong>
                    {properties.isDirectory
                      ? `${(properties.files ?? 0).toLocaleString()} 文件`
                      : formatBytes(properties.allocatedBytes ?? properties.size)}
                  </strong>
                  <small>
                    {properties.isDirectory
                      ? `${(properties.directories ?? 0).toLocaleString()} 个子目录`
                      : "按文件系统分配块估算"}
                  </small>
                </article>
                <article>
                  {properties.isDirectory ? <Folder size={18} /> : <File size={18} />}
                  <span>项目类型</span>
                  <strong>{propertyType(properties)}</strong>
                  <small>{properties.writable ? "可读写" : properties.readable ? "只读访问" : "访问受限"}</small>
                </article>
              </div>

              <div className="path-properties-grid">
                <article>
                  <h3>常规信息</h3>
                  <dl>
                    <div>
                      <dt>名称</dt>
                      <dd>{properties.name}</dd>
                    </div>
                    <div>
                      <dt>类型</dt>
                      <dd>{propertyType(properties)}</dd>
                    </div>
                    <div>
                      <dt>位置</dt>
                      <dd>{properties.parentPath}</dd>
                    </div>
                    <div>
                      <dt>扩展名</dt>
                      <dd>{properties.extension ? `.${properties.extension}` : "无"}</dd>
                    </div>
                    {properties.linkTarget && (
                      <div>
                        <dt>链接目标</dt>
                        <dd>{properties.linkTarget}</dd>
                      </div>
                    )}
                  </dl>
                </article>

                <article>
                  <h3>时间与访问</h3>
                  <dl>
                    <div>
                      <dt>创建时间</dt>
                      <dd><DateValue value={properties.createdAt} /></dd>
                    </div>
                    <div>
                      <dt>修改时间</dt>
                      <dd><DateValue value={properties.modifiedAt} /></dd>
                    </div>
                    <div>
                      <dt>访问时间</dt>
                      <dd><DateValue value={properties.accessedAt} /></dd>
                    </div>
                    <div>
                      <dt>当前权限</dt>
                      <dd className="path-properties-access">
                        {properties.readable && <span><Check size={11} />读取</span>}
                        {properties.writable && <span><Check size={11} />写入</span>}
                        {!properties.readable && !properties.writable && "无访问权限"}
                      </dd>
                    </div>
                  </dl>
                </article>
              </div>
            </>
          )}
        </div>

        <footer>
          <span><CalendarClock size={13} /> 信息直接读取自当前文件系统</span>
          <div>
            <button
              type="button"
              disabled={!properties || renameBusy}
              onClick={() => {
                setNewName(properties?.name ?? "");
                setRenaming(true);
              }}
            >
              <Pencil size={12} />
              重命名
            </button>
            <button type="button" onClick={() => void api.revealPath(activePath)}>
              在文件管理器中显示
            </button>
            <button type="button" className="primary" onClick={onClose}>完成</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}
