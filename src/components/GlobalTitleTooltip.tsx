import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CACHE_ATTR = "data-codev-tooltip";
const SHOW_DELAY_MS = 320;
const EDGE_GAP = 8;
const OFFSET_Y = 8;

type TooltipState = {
  target: HTMLElement;
  text: string;
};

/**
 * 向上查找最近带 `title` 或已缓存 `data-codev-tooltip` 的元素。
 * 若元素位于 Radix TooltipTrigger 内部，则交由组件自身处理，避免双重弹窗。
 */
function findTooltipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  let el: Element | null = node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement) {
      if (
        el.hasAttribute("data-slot") &&
        el.getAttribute("data-slot") === "tooltip-trigger"
      ) {
        return null;
      }
      const rawTitle = el.getAttribute("title");
      if (rawTitle && rawTitle.trim().length > 0) {
        el.setAttribute(CACHE_ATTR, rawTitle);
        el.removeAttribute("title");
        return el;
      }
      const cached = el.getAttribute(CACHE_ATTR);
      if (cached && cached.trim().length > 0) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * 全局单一托管 Tooltip 引擎：
 * 自动接管全站原生 `title` 属性，彻底阻止系统默认白底提示框，
 * 统一使用与 `[data-slot="tooltip-content"]` 一致的 Codev 主题视觉与自适应定位。
 */
export function GlobalTitleTooltip() {
  const [active, setActive] = useState<TooltipState | null>(null);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    ready: boolean;
  }>({
    left: 0,
    top: 0,
    ready: false,
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const pendingTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      pendingTargetRef.current = null;
      setActive(null);
      setCoords((prev) => (prev.ready ? { ...prev, ready: false } : prev));
    };

    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = findTooltipTarget(event.target);
      if (!target) {
        if (pendingTargetRef.current) hide();
        return;
      }
      // 读取最新文本（若业务代码动态更新了 title，findTooltipTarget 已同步进 CACHE_ATTR）
      const text = target.getAttribute(CACHE_ATTR)?.trim() ?? "";
      if (!text) {
        hide();
        return;
      }
      if (pendingTargetRef.current === target) {
        setActive((prev) =>
          prev && prev.target === target && prev.text !== text
            ? { target, text }
            : prev,
        );
        return;
      }
      clearTimer();
      pendingTargetRef.current = target;
      timerRef.current = window.setTimeout(() => {
        if (!target.isConnected) {
          hide();
          return;
        }
        const latest =
          target.getAttribute("title")?.trim() ||
          target.getAttribute(CACHE_ATTR)?.trim() ||
          "";
        if (target.hasAttribute("title")) {
          target.setAttribute(CACHE_ATTR, latest);
          target.removeAttribute("title");
        }
        if (!latest) {
          hide();
          return;
        }
        setActive({ target, text: latest });
      }, SHOW_DELAY_MS);
    };

    const handlePointerOut = (event: PointerEvent) => {
      const current = pendingTargetRef.current;
      if (!current) return;
      const related = event.relatedTarget;
      if (related instanceof Node && current.contains(related)) return;
      hide();
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);

    return () => {
      clearTimer();
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!active || !boxRef.current) return;
    const rect = active.target.getBoundingClientRect();
    const box = boxRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(EDGE_GAP, Math.min(left, vw - box.width - EDGE_GAP));

    let top = rect.top - box.height - OFFSET_Y;
    if (top < EDGE_GAP) {
      top = Math.min(rect.bottom + OFFSET_Y, vh - box.height - EDGE_GAP);
    }

    setCoords({ left, top, ready: true });
  }, [active]);

  if (!active) return null;

  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      data-slot="tooltip-content"
      style={{
        position: "fixed",
        left: coords.left,
        top: coords.top,
        opacity: coords.ready ? 1 : 0,
        pointerEvents: "none",
      }}
      className="z-[100] max-w-72 rounded-lg bg-foreground px-2.5 py-1.5 text-[11px] leading-relaxed text-background whitespace-pre-wrap break-words shadow-md transition-opacity duration-100"
    >
      {active.text}
    </div>,
    document.body,
  );
}
