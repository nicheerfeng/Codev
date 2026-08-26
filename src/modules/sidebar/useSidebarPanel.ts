import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_WIDTH_STORAGE_KEY = "codev.sidebar.width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "codev.sidebar.collapsed";

export function shouldPersistSidebarWidth(
  width: number,
  isUserInteraction: boolean,
): boolean {
  return isUserInteraction && width > 0;
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(width));
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

type FocusableExplorer = {
  focus: () => void;
  isFocused: () => boolean;
};

export function useSidebarPanel(
  explorerRef: RefObject<FocusableExplorer | null>,
) {
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [initialSidebarCollapsed] = useState(readSidebarCollapsed);
  const collapsedRef = useRef(initialSidebarCollapsed);

  const persistSidebarCollapsed = useCallback((collapsed: boolean) => {
    if (collapsedRef.current === collapsed) return;
    collapsedRef.current = collapsed;
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // storage may fail in private mode
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.resize(`${sidebarWidthRef.current}px`);
    else p.collapse();
  }, []);

  const persistSidebarWidth = useCallback(
    (next: number, isUserInteraction: boolean) => {
      if (!shouldPersistSidebarWidth(next, isUserInteraction)) return;
      sidebarWidthRef.current = next;
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
      sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
        sidebarWidthWriteTimerRef.current = 0;
        try {
          window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
        } catch {
          // ignore
        }
      }, 200);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [explorerRef]);

  return {
    sidebarRef,
    sidebarWidthRef,
    initialSidebarCollapsed,
    persistSidebarCollapsed,
    toggleSidebar,
    persistSidebarWidth,
    toggleExplorerFocus,
  };
}
