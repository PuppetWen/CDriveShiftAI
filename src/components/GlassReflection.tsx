import { useEffect } from "react";

const surfaces = ".glass-card, .path-input, .search-input-wrap, .ownership-search, .sidebar, .topbar, .quick-search-titlebar, .path-properties-dialog, .force-delete-dialog";

/** One event-driven reflection for the surface under the pointer. No idle
 * animation, React renders, or individual listeners on large file lists. */
export function GlassReflection() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (forced-colors: active), (prefers-contrast: more)");
    let active: HTMLElement | null = null;
    let frame = 0;
    let pointer: { target: EventTarget | null; x: number; y: number } | null = null;

    const clear = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (active) {
        delete active.dataset.glassLit;
        active.style.removeProperty("--glass-pointer-x");
        active.style.removeProperty("--glass-pointer-y");
        active = null;
      }
    };

    const paint = () => {
      frame = 0;
      if (!pointer || reduced.matches || document.hidden) return clear();
      const target = pointer.target instanceof Element
        ? pointer.target.closest<HTMLElement>(surfaces)
        : null;
      if (target !== active) {
        clear();
        active = target;
      }
      if (!active?.isConnected) return clear();
      const bounds = active.getBoundingClientRect();
      active.style.setProperty("--glass-pointer-x", `${Math.round(pointer.x - bounds.left)}px`);
      active.style.setProperty("--glass-pointer-y", `${Math.round(pointer.y - bounds.top)}px`);
      active.dataset.glassLit = "true";
    };

    const move = (event: PointerEvent) => {
      if (reduced.matches || event.pointerType === "touch" || event.buttons) return clear();
      pointer = { target: event.target, x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const visibility = () => { if (document.hidden) clear(); };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", clear);
    document.addEventListener("pointerdown", clear, { passive: true });
    document.addEventListener("scroll", clear, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", clear);
    reduced.addEventListener("change", clear);
    return () => {
      clear();
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", clear);
      document.removeEventListener("pointerdown", clear);
      document.removeEventListener("scroll", clear, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", clear);
      reduced.removeEventListener("change", clear);
    };
  }, []);

  return null;
}
