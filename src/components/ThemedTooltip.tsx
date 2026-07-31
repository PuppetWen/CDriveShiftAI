import {
  useEffect,
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
  delay = 360
}: {
  content: string;
  children: ReactNode;
  delay?: number;
}) {
  const [position, setPosition] = useState<TooltipPosition>();
  const timer = useRef<number | undefined>(undefined);

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
      const estimatedWidth = Math.min(330, Math.max(150, content.length * 14));
      setPosition({
        left: Math.max(
          10,
          Math.min(next.left - estimatedWidth / 2, window.innerWidth - estimatedWidth - 10)
        ),
        top: Math.max(10, Math.min(next.top, window.innerHeight - 64))
      });
    }, delay);
  };

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
            className="themed-tooltip"
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
