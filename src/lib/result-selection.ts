import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject, type SetStateAction } from "react";

interface SelectionState {
  paths: Set<string>;
  primary: string;
}

export interface SelectionRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function selectionRange(top: number, bottom: number, rowHeight: number, count: number) {
  return {
    start: Math.min(count, Math.max(0, Math.floor(Math.min(top, bottom) / rowHeight))),
    end: Math.min(count, Math.max(0, Math.ceil(Math.max(top, bottom) / rowHeight)))
  };
}

export function toggleResultSelection(current: ReadonlySet<string>, path: string) {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

const samePaths = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((path) => right.has(path));

export function useResultSelection(
  items: readonly { path: string }[],
  containerRef: RefObject<HTMLDivElement | null>,
  rowHeight: number,
  resetKey: string,
  visible: boolean
) {
  const [selection, setSelection] = useState<SelectionState>(() => ({ paths: new Set(), primary: "" }));
  const [rectangle, setRectangle] = useState<SelectionRectangle>();
  const current = useRef({ items, selection, rowHeight });
  current.current = { items, selection, rowHeight };
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const lastDragEnd = useRef(-Infinity);

  const setSelectedPath = useCallback((value: SetStateAction<string>) => {
    setSelection((before) => {
      const primary = typeof value === "function" ? value(before.primary) : value;
      if (typeof value === "function" && primary === before.primary) return before;
      return { primary, paths: new Set(primary ? [primary] : []) };
    });
  }, []);

  const selectPath = useCallback((path: string, additive: boolean) => {
    setSelection((before) => {
      const paths = additive ? toggleResultSelection(before.paths, path) : new Set([path]);
      return { paths, primary: paths.has(path) ? path : [...paths].at(-1) ?? "" };
    });
  }, []);

  const selectContextPath = useCallback((path: string) => {
    setSelection((before) => ({ paths: before.paths.has(path) ? before.paths : new Set([path]), primary: path }));
  }, []);

  useEffect(() => {
    const available = new Set(items.map((item) => item.path));
    setSelection((before) => {
      const paths = new Set([...before.paths].filter((path) => available.has(path)));
      if (samePaths(paths, before.paths)) return before;
      return { paths, primary: paths.has(before.primary) ? before.primary : [...paths].at(-1) ?? "" };
    });
  }, [items]);

  useEffect(() => {
    cancelRef.current?.();
    return () => cancelRef.current?.();
  }, [resetKey, visible]);

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onDoubleClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (performance.now() - lastDragEnd.current >= 400) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.pointerType && event.pointerType !== "mouse")) return;
    // A fresh press is independent of a cancelled drag, including a press on
    // a row action that does not itself participate in rectangle selection.
    suppressClick.current = false;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, a, input, textarea, select, [role='button'], [contenteditable='true'], [data-selection-ignore]")) return;
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const clientLeft = bounds.left + container.clientLeft;
    const clientTop = bounds.top + container.clientTop;
    if (event.clientX < clientLeft || event.clientX >= clientLeft + container.clientWidth || event.clientY < clientTop || event.clientY >= clientTop + container.clientHeight) return;
    cancelRef.current?.();
    const start = { x: event.clientX - clientLeft + container.scrollLeft, y: event.clientY - clientTop + container.scrollTop };
    const initialPointer = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const base = event.ctrlKey || event.metaKey ? new Set(current.current.selection.paths) : new Set<string>();
    let pointer = initialPointer;
    let dragging = false;
    let frame = 0;
    let lastTime = 0;
    let stopped = false;
    const applyRectangle = () => {
      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(container.clientWidth, pointer.x - rect.left - container.clientLeft)) + container.scrollLeft;
      const y = Math.max(0, Math.min(container.clientHeight, pointer.y - rect.top - container.clientTop)) + container.scrollTop;
      const box = { left: Math.min(start.x, x), top: Math.min(start.y, y), width: Math.max(1, Math.abs(start.x - x)), height: Math.max(1, Math.abs(start.y - y)) };
      setRectangle(box);
      const { items: currentItems, rowHeight: height } = current.current;
      const range = selectionRange(box.top, box.top + box.height, height, currentItems.length);
      const paths = new Set(base);
      for (let index = range.start; index < range.end; index += 1) paths.add(currentItems[index].path);
      const edgePath = range.end > range.start ? currentItems[y >= start.y ? range.end - 1 : range.start]?.path : undefined;
      const primary = edgePath ?? [...paths].at(-1) ?? "";
      setSelection((before) => samePaths(before.paths, paths) && before.primary === primary ? before : { paths, primary });
    };
    const tick = (time: number) => {
      frame = 0;
      if (stopped || !dragging) return;
      const rect = container.getBoundingClientRect();
      const localY = pointer.y - rect.top - container.clientTop;
      const edge = Math.min(36, container.clientHeight / 3);
      const speed = localY < edge ? -Math.min(18, (edge - localY) / 2) : localY > container.clientHeight - edge ? Math.min(18, (localY - container.clientHeight + edge) / 2) : 0;
      const before = container.scrollTop;
      const elapsed = lastTime ? Math.min(32, time - lastTime) : 16;
      lastTime = time;
      if (speed) container.scrollTop += speed * elapsed / 16;
      applyRectangle();
      // Continue only while actively scrolling. A stationary drag has no timer.
      if (container.scrollTop !== before) frame = requestAnimationFrame(tick);
    };
    const schedule = () => { if (!frame && dragging && !stopped) frame = requestAnimationFrame(tick); };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      pointer = { x: next.clientX, y: next.clientY };
      if (!dragging && Math.hypot(pointer.x - initialPointer.x, pointer.y - initialPointer.y) >= 4) {
        dragging = true;
        container.setPointerCapture(pointerId);
      }
      if (dragging) {
        next.preventDefault();
        schedule();
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibilityChanged);
      container.removeEventListener("scroll", schedule);
      if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
      setRectangle(undefined);
      cancelRef.current = undefined;
    };
    const up = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (dragging) {
        pointer = { x: next.clientX, y: next.clientY };
        applyRectangle();
        suppressClick.current = true;
        lastDragEnd.current = performance.now();
        next.preventDefault();
      } else if (!target.closest(".result-row") && !event.ctrlKey && !event.metaKey) {
        setSelectedPath("");
      }
      stop();
    };
    const cancel = () => { if (dragging) suppressClick.current = true; stop(); };
    const visibilityChanged = () => { if (document.visibilityState === "hidden") cancel(); };
    cancelRef.current = cancel;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibilityChanged);
    container.addEventListener("scroll", schedule);
  }, [containerRef, setSelectedPath]);

  return {
    selectedPath: selection.primary,
    selectedPaths: selection.paths,
    setSelectedPath,
    selectPath,
    selectContextPath,
    rectangle,
    onPointerDown,
    onClickCapture,
    onDoubleClickCapture
  };
}
