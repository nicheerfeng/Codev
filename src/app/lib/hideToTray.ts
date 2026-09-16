import { getCurrentWindow } from "@tauri-apps/api/window";

/** 关窗口时藏到托盘，不结束 Pi。 */
export async function hideMainWindowToTray(): Promise<void> {
  const window = getCurrentWindow();
  try {
    await window.hide();
  } catch {
    await window.minimize();
  }
}

/** 从托盘或通知把主窗口拉回来。 */
export async function showMainWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
  await window.setFocus();
}
