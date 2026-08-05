import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

interface TooltipPosition {
  left: number;
  top: number;
}

export function ThemedTooltip({
  content,
  children,
  delay = 360,
  wrap = false
}: {
  content: string;
  children: ReactNode;
  delay?: number;
  wrap?: boolean;
}) {
  const [position, setPosition] = useState<TooltipPosition>();
  const timer = useRef<number | undefined>(undefined);
  const tooltip = useRef<HTMLDivElement | null>(null);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setPosition(undefined);
  };

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const queue = (next: TooltipPosition) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const maximumWidth = wrap ? Math.min(680, window.innerWidth - 20) : 330;
      const estimatedWidth = Math.min(maximumWidth, Math.max(150, content.length * 8));
      setPosition({
        left: Math.max(
          10,
          Math.min(next.left - estimatedWidth / 2, window.innerWidth - estimatedWidth - 10)
        ),
        top: Math.max(10, Math.min(next.top, window.innerHeight - 64))
      });
    }, delay);
  };

  useLayoutEffect(() => {
    if (!position || !tooltip.current) return;
    const bounds = tooltip.current.getBoundingClientRect();
    const next = {
      left: Math.max(10, Math.min(position.left, window.innerWidth - bounds.width - 10)),
      top: Math.max(10, Math.min(position.top, window.innerHeight - bounds.height - 10))
    };
    if (Math.abs(next.left - position.left) > 0.5 || Math.abs(next.top - position.top) > 0.5) {
      setPosition(next);
    }
  }, [position]);

  const mouseEnter = (event: MouseEvent<HTMLSpanElement>) => {
    const target = event.currentTarget.firstElementChild;
    const bounds = target?.getBoundingClientRect();
    queue({
      left: bounds ? bounds.left + bounds.width / 2 : event.clientX,
      top: bounds ? bounds.bottom + 9 : event.clientY + 12
    });
  };

  const focus = (event: FocusEvent<HTMLSpanElement>) => {
    const target = event.currentTarget.firstElementChild;
    const bounds = target?.getBoundingClientRect();
    if (!bounds) return;
    queue({ left: bounds.left + bounds.width / 2, top: bounds.bottom + 9 });
  };

  return (
    <>
      <span
        className="themed-tooltip-anchor"
        onMouseEnter={mouseEnter}
        onMouseLeave={clear}
        onFocusCapture={focus}
        onBlurCapture={clear}
      >
        {children}
      </span>
      {position &&
        createPortal(
          <div
            className={`themed-tooltip${wrap ? " themed-tooltip--wrap" : ""}`}
            ref={tooltip}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
          >
            <i />
            <span>{content}</span>
          </div>,
          document.body
        )}
    </>
  );
}
