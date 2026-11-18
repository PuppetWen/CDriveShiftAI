import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface VirtualListRange {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

export function calculateVirtualListRange(
  itemCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8
): VirtualListRange {
  if (itemCount === 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const visibleHeight = Math.max(rowHeight, viewportHeight);
  const offset = Math.max(0, Math.min(scrollTop, (itemCount - 1) * rowHeight));
  const start = Math.max(0, Math.floor(offset / rowHeight) - overscan);
  const end = Math.min(
    itemCount,
    Math.ceil((offset + visibleHeight) / rowHeight) + overscan
  );
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (itemCount - end) * rowHeight)
  };
}

export function useVirtualList(
  itemCount: number,
  rowHeight: number,
  overscan = 8
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);
  const [range, setRange] = useState(() => calculateVirtualListRange(itemCount, rowHeight, 0, 0, overscan));
  const config = useRef({ itemCount, rowHeight, overscan });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { itemCount, rowHeight, overscan } = config.current;
    const next = calculateVirtualListRange(itemCount, rowHeight, container.scrollTop, container.clientHeight, overscan);
    setRange((current) => current.start === next.start && current.end === next.end &&
      current.paddingTop === next.paddingTop && current.paddingBottom === next.paddingBottom ? current : next);
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (!frameRef.current) {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0;
        measure();
      });
    }
  }, [measure]);

  const attachContainer = useCallback((container: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    containerRef.current = container;
    if (!container) return;
    const observer = new ResizeObserver(scheduleMeasure);
    observerRef.current = observer;
    observer.observe(container);
    scheduleMeasure();
  }, [scheduleMeasure]);

  useLayoutEffect(() => {
    config.current = { itemCount, rowHeight, overscan };
    measure();
  }, [itemCount, measure, overscan, rowHeight]);

  const resetScroll = useCallback(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = 0;
    measure();
  }, [measure]);

  return {
    containerRef,
    attachContainer,
    onScroll: scheduleMeasure,
    resetScroll,
    ...range
  };
}
