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
import { useI18n } from "../lib/i18n";
import { formatBytes } from "../lib/format";
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

function propertyType(value: PathProperties, ui: (zh: string, en: string) => string) {
  if (value.isSymbolicLink) {
    return value.isDirectory
      ? ui("目录符号链接", "Directory symbolic link")
      : ui("文件符号链接", "File symbolic link");
  }
  if (value.isDirectory) return ui("文件夹", "Folder");
  return value.extension
    ? ui(`${value.extension.toUpperCase()} 文件`, `${value.extension.toUpperCase()} file`)
    : ui("文件", "File");
}

function DateValue({ value }: { value?: string }) {
  const { ui, formatDate } = useI18n();
  return <span>{value ? formatDate(value) : ui("无可用记录", "No record available")}</span>;
}

export function PathPropertiesDialog({
  path,
  onClose,
  onRenamed,
  notify
}: PathPropertiesDialogProps) {
  const { ui, formatNumber } = useI18n();
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
    const move = (event: MouseEvent | PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (event instanceof PointerEvent && drag.pointerId >= 0 && event.pointerId !== drag.pointerId) {
        return;
      }
      setPosition(
        clampPosition({
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY
        })
      );
    };
    const finish = (pointerId?: number) => {
      if (
        pointerId != null &&
        dragRef.current &&
        dragRef.current.pointerId >= 0 &&
        dragRef.current.pointerId !== pointerId
      ) {
        return;
      }
      dragRef.current = undefined;
    };
    const finishPointer = (event: PointerEvent) => finish(event.pointerId);
    const finishMouse = () => finish();
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finishPointer, true);
    window.addEventListener("pointercancel", finishPointer, true);
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", finishMouse, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finishPointer, true);
      window.removeEventListener("pointercancel", finishPointer, true);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", finishMouse, true);
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
      notify("success", ui("完整路径已复制", "Full path copied"));
    } catch (reason) {
      notify("error", reason instanceof Error ? reason.message : String(reason));
    }
  };

  const renameItem = async () => {
    if (!properties || renameBusy) return;
    const requestedName = newName.trim();
    if (!requestedName) {
      notify("error", ui("名称不能为空", "The name cannot be empty"));
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
      notify("success", ui("重命名完成", "Rename completed"));
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
        aria-label={ui(`${properties?.name ?? activePath} 的属性`, `Properties for ${properties?.name ?? activePath}`)}
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
            <span>{ui("项目属性", "Item properties")}</span>
            <strong>{properties?.name ?? ui("正在读取…", "Loading…")}</strong>
          </div>
          <div className="path-properties-drag-hint">
            <MousePointer2 size={12} />
            {ui("拖动窗口", "Drag window")}
          </div>
          <button type="button" onClick={onClose} aria-label={ui("关闭属性窗口", "Close properties")}>
            <X size={18} />
          </button>
        </header>

        <div className="path-properties-body">
          {error ? (
            <div className="path-properties-error">
              <LockKeyhole size={28} />
              <strong>{ui("无法读取该项目", "Unable to read this item")}</strong>
              <span>{error}</span>
            </div>
          ) : !properties ? (
            <div className="path-properties-loading">
              <i />
              <strong>{ui("正在读取文件系统信息", "Reading file system information")}</strong>
              <span>{ui("大型目录的容量与项目数量统计可能需要一点时间。", "Size and item counts for large folders may take a moment.")}</span>
            </div>
          ) : (
            <>
              <div className="path-properties-path">
                <FolderOpen size={16} />
                <span>{properties.path}</span>
                <button type="button" onClick={() => void copyPath()}>
                  <Clipboard size={14} />
                  {ui("复制", "Copy")}
                </button>
              </div>
              {renaming && (
                <div className="path-properties-rename">
                  <Pencil size={15} />
                  <label htmlFor="path-properties-rename-input">{ui("重命名", "Rename")}</label>
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
                    {ui("取消", "Cancel")}
                  </button>
                  <button
                    type="button"
                    className="confirm"
                    disabled={renameBusy}
                    onClick={() => void renameItem()}
                  >
                    {renameBusy ? ui("处理中…", "Working…") : ui("确认", "Confirm")}
                  </button>
                </div>
              )}

              <div className="path-properties-metrics">
                <article>
                  <Ruler size={18} />
                  <span>{ui("大小", "Size")}</span>
                  <strong>{formatBytes(properties.size)}</strong>
                  <small>
                    {properties.scanComplete
                      ? ui("统计完成", "Scan complete")
                      : ui("受时间或权限限制，为当前可读大小", "Readable size only due to time or permission limits")}
                  </small>
                </article>
                <article>
                  <HardDrive size={18} />
                  <span>{properties.isDirectory ? ui("所含项目", "Items") : ui("占用空间", "Allocated size")}</span>
                  <strong>
                    {properties.isDirectory
                      ? ui(`${(properties.files ?? 0).toLocaleString()} 文件`, `${formatNumber(properties.files ?? 0)} files`)
                      : formatBytes(properties.allocatedBytes ?? properties.size)}
                  </strong>
                  <small>
                    {properties.isDirectory
                      ? ui(`${(properties.directories ?? 0).toLocaleString()} 个子目录`, `${formatNumber(properties.directories ?? 0)} subfolders`)
                      : ui("按文件系统分配块估算", "Estimated from file-system allocation")}
                  </small>
                </article>
                <article>
                  {properties.isDirectory ? <Folder size={18} /> : <File size={18} />}
                  <span>{ui("项目类型", "Item type")}</span>
                  <strong>{propertyType(properties, ui)}</strong>
                  <small>{properties.writable ? ui("可读写", "Read and write") : properties.readable ? ui("只读访问", "Read-only access") : ui("访问受限", "Access restricted")}</small>
                </article>
              </div>

              <div className="path-properties-grid">
                <article>
                  <h3>{ui("常规信息", "General")}</h3>
                  <dl>
                    <div>
                      <dt>{ui("名称", "Name")}</dt>
                      <dd>{properties.name}</dd>
                    </div>
                    <div>
                      <dt>{ui("类型", "Type")}</dt>
                      <dd>{propertyType(properties, ui)}</dd>
                    </div>
                    <div>
                      <dt>{ui("位置", "Location")}</dt>
                      <dd>{properties.parentPath}</dd>
                    </div>
                    <div>
                      <dt>{ui("扩展名", "Extension")}</dt>
                      <dd>{properties.extension ? `.${properties.extension}` : ui("无", "None")}</dd>
                    </div>
                    {properties.linkTarget && (
                      <div>
                        <dt>{ui("链接目标", "Link target")}</dt>
                        <dd>{properties.linkTarget}</dd>
                      </div>
                    )}
                  </dl>
                </article>

                <article>
                  <h3>{ui("时间与访问", "Time and access")}</h3>
                  <dl>
                    <div>
                      <dt>{ui("创建时间", "Created")}</dt>
                      <dd><DateValue value={properties.createdAt} /></dd>
                    </div>
                    <div>
                      <dt>{ui("修改时间", "Modified")}</dt>
                      <dd><DateValue value={properties.modifiedAt} /></dd>
                    </div>
                    <div>
                      <dt>{ui("访问时间", "Accessed")}</dt>
                      <dd><DateValue value={properties.accessedAt} /></dd>
                    </div>
                    <div>
                      <dt>{ui("当前权限", "Current access")}</dt>
                      <dd className="path-properties-access">
                        {properties.readable && <span><Check size={11} />{ui("读取", "Read")}</span>}
                        {properties.writable && <span><Check size={11} />{ui("写入", "Write")}</span>}
                        {!properties.readable && !properties.writable && ui("无访问权限", "No access")}
                      </dd>
                    </div>
                  </dl>
                </article>
              </div>
            </>
          )}
        </div>

        <footer>
          <span><CalendarClock size={13} /> {ui("信息直接读取自当前文件系统", "Information read directly from the current file system")}</span>
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
              {ui("重命名", "Rename")}
            </button>
            <button type="button" onClick={() => void api.revealPath(activePath)}>
              {ui("在文件管理器中显示", "Show in File Explorer")}
            </button>
            <button type="button" className="primary" onClick={onClose}>{ui("完成", "Done")}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}
