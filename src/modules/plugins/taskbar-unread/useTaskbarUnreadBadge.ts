import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderUnreadBadgePng } from "./taskbarUnreadBadge";
import { subscribeUnreadTasks, unreadTaskCount } from "./unreadTasks";

/** 把完成待读总数叠到 Windows 任务栏图标右下角；关闭插件只撤角标。 */
export function useTaskbarUnreadBadge(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      void getCurrentWindow()
        .setOverlayIcon()
        .catch(() => {});
      return;
    }
    let disposed = false;
    let last = -1;
    const sync = () => {
      const count = unreadTaskCount();
      if (count === last) return;
      last = count;
      void applyOverlay(count).catch(() => {});
    };
    const stop = subscribeUnreadTasks(sync);
    sync();
    return () => {
      disposed = true;
      stop();
      void getCurrentWindow()
        .setOverlayIcon()
        .catch(() => {});
    };

    async function applyOverlay(count: number) {
      if (disposed) return;
      const window = getCurrentWindow();
      if (count <= 0) {
        await window.setOverlayIcon();
        return;
      }
      const png = renderUnreadBadgePng(count);
      if (!png || disposed) return;
      await window.setOverlayIcon(png);
    }
  }, [enabled]);
}
