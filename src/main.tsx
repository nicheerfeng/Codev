import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { IS_WINDOWS, USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

const OPAQUE_WINDOW =
  IS_WINDOWS || import.meta.env.VITE_CODEV_OPAQUE_WINDOW === "1";

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

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
