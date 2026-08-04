import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent
} from "react";

interface VirtualListState {
  scrollTop: number;
  viewportHeight: number;
}

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
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(
    itemCount,
    Math.ceil((scrollTop + visibleHeight) / rowHeight) + overscan
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
  const [state, setState] = useState<VirtualListState>({
    scrollTop: 0,
    viewportHeight: 0
  });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setState((current) => {
      const next = {
        scrollTop: container.scrollTop,
        viewportHeight: container.clientHeight
      };
      return current.scrollTop === next.scrollTop &&
        current.viewportHeight === next.viewportHeight
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [itemCount, measure, rowHeight]);

  const onScroll = useCallback(
    (_event: UIEvent<HTMLDivElement>) => measure(),
    [measure]
  );

  const range = useMemo(
    () =>
      calculateVirtualListRange(
        itemCount,
        rowHeight,
        state.scrollTop,
        state.viewportHeight,
        overscan
      ),
    [itemCount, overscan, rowHeight, state.scrollTop, state.viewportHeight]
  );

  const resetScroll = useCallback(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = 0;
    setState((current) => ({ ...current, scrollTop: 0 }));
  }, []);

  return {
    containerRef,
    onScroll,
    resetScroll,
    ...range
  };
}
