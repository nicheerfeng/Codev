import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { initUiState } from "./lib/uiState";
import { IS_WINDOWS, USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

const OPAQUE_WINDOW =
  IS_WINDOWS || import.meta.env.VITE_CODEV_OPAQUE_WINDOW === "1";
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;
const WINDOW_SCREEN_MARGIN = 0.9;

async function getStartupWindowSize() {
  const monitor = await currentMonitor();
  if (!monitor) {
    return new LogicalSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
  }

  const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
  return new LogicalSize(
    Math.max(
      420,
      Math.min(DEFAULT_WINDOW_WIDTH, workArea.width * WINDOW_SCREEN_MARGIN),
    ),
    Math.max(
      280,
      Math.min(DEFAULT_WINDOW_HEIGHT, workArea.height * WINDOW_SCREEN_MARGIN),
    ),
  );
}

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
  if (OPAQUE_WINDOW) document.documentElement.dataset.windowOpacity = "opaque";
}

/** 禁止主窗口浏览器右键菜单，同时放行应用菜单与可编辑控件。 */
function blockNativeContextMenu(event: MouseEvent) {
  if (event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest('[data-slot="context-menu-trigger"]') ||
    target.closest("input, textarea, select, [contenteditable='true']")
  ) {
    return;
  }
  event.preventDefault();
}

document.addEventListener("contextmenu", blockNativeContextMenu);

/** 选区拖不要变成系统 DnD；文件拖走 Tauri 原生落点，排序走 pointer 捕获。 */
function blockHtml5DragStart(event: DragEvent) {
  event.preventDefault();
}
document.addEventListener("dragstart", blockHtml5DragStart);

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();
await initUiState().catch((error) => console.error("读取界面状态失败", error));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

let restoringWindowSize = false;

/** 恢复被系统或无边框布局压缩到异常尺寸的主窗口。 */
async function restoreInvalidWindowSize() {
  if (restoringWindowSize) return;
  const window = getCurrentWindow();
  if (await window.isMinimized()) return;
  const size = await window.innerSize();
  if (size.width >= 420 && size.height >= 280) return;

  restoringWindowSize = true;
  try {
    await window.setSize(await getStartupWindowSize());
    await window.center();
  } finally {
    restoringWindowSize = false;
  }
}

const currentWindow = getCurrentWindow();
void currentWindow.onFocusChanged(({ payload }) => {
  if (payload) void restoreInvalidWindowSize();
});
void currentWindow.onResized(() => {
  void restoreInvalidWindowSize();
});

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getStartupWindowSize()
    .then((size) => currentWindow.setSize(size))
    .then(() => currentWindow.center())
    .then(() => restoreInvalidWindowSize())
    .then(() => currentWindow.show())
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
