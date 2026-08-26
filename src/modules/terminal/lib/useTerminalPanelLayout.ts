import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const TERMINAL_DEFAULT_WIDTH = 480;
export const TERMINAL_MIN_WIDTH = 220;
const TERMINAL_WIDTH_STORAGE_KEY = "codev.terminal.width";
const TERMINAL_COLLAPSED_STORAGE_KEY = "codev.terminal.collapsed";

/** 仅持久化用户拖拽产生的有效终端宽度。 */
export function shouldPersistTerminalWidth(
  width: number,
  isUserInteraction: boolean,
): boolean {
  return isUserInteraction && width > 0;
}

/** 读取终端最近一次非折叠宽度。 */
function readTerminalWidth(): number {
  try {
    const stored = window.localStorage.getItem(TERMINAL_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? Math.max(TERMINAL_MIN_WIDTH, parsed)
      : TERMINAL_DEFAULT_WIDTH;
  } catch {
    return TERMINAL_DEFAULT_WIDTH;
  }
}

/** 读取终端面板上次折叠状态。 */
function readTerminalCollapsed(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 管理右侧终端面板宽度、折叠状态和持久化。 */
export function useTerminalPanelLayout() {
  const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);
  const terminalWidthRef = useRef(readTerminalWidth());
  const widthWriteTimerRef = useRef(0);
  const [initialTerminalCollapsed] = useState(readTerminalCollapsed);
  const [terminalPanelCollapsed, setTerminalPanelCollapsed] = useState(
    initialTerminalCollapsed,
  );

  /** 更新并保存终端折叠状态。 */
  const persistTerminalCollapsed = useCallback((collapsed: boolean) => {
    setTerminalPanelCollapsed(collapsed);
    try {
      window.localStorage.setItem(
        TERMINAL_COLLAPSED_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // storage may fail in private mode
    }
  }, []);

  /** 防抖保存用户最近一次终端拖拽宽度。 */
  const persistTerminalWidth = useCallback(
    (width: number, isUserInteraction: boolean) => {
      if (!shouldPersistTerminalWidth(width, isUserInteraction)) return;
      terminalWidthRef.current = width;
      if (widthWriteTimerRef.current) {
        window.clearTimeout(widthWriteTimerRef.current);
      }
      widthWriteTimerRef.current = window.setTimeout(() => {
        widthWriteTimerRef.current = 0;
        try {
          window.localStorage.setItem(
            TERMINAL_WIDTH_STORAGE_KEY,
            String(width),
          );
        } catch {
          // storage may fail in private mode
        }
      }, 200);
    },
    [],
  );

  /** 按最近一次非折叠宽度展开终端面板。 */
  const expandTerminalPanel = useCallback(() => {
    terminalPanelRef.current?.resize(`${terminalWidthRef.current}px`);
  }, []);

  useEffect(
    () => () => {
      if (widthWriteTimerRef.current) {
        window.clearTimeout(widthWriteTimerRef.current);
      }
    },
    [],
  );

  return {
    terminalPanelRef,
    terminalWidthRef,
    initialTerminalCollapsed,
    terminalPanelCollapsed,
    persistTerminalCollapsed,
    persistTerminalWidth,
    expandTerminalPanel,
  };
}
