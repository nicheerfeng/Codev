import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { projectName } from "./organization";
import {
  finishNotificationCopy,
  shouldSkipFinishNotification,
  type ActivityThread,
} from "./projectActivity";
import type { PiTurnOutcome } from "./types";

let permissionAsked = false;

async function ensurePermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    if (permissionAsked) return false;
    permissionAsked = true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function piPanelIsForeground(piActive: boolean): Promise<boolean> {
  try {
    const window = getCurrentWindow();
    const [visible, focused, minimized] = await Promise.all([
      window.isVisible(),
      window.isFocused(),
      window.isMinimized(),
    ]);
    return shouldSkipFinishNotification({
      visible,
      focused,
      minimized,
      piActive,
    });
  } catch {
    return false;
  }
}

/** Only a native terminal outcome can produce a completion notification. */
export async function notifyFinishedThread(input: {
  thread: ActivityThread;
  outcome: PiTurnOutcome;
  piActive: boolean;
}): Promise<void> {
  if (input.outcome === "interrupted") return;
  if (await piPanelIsForeground(input.piActive)) return;
  if (!(await ensurePermission())) return;
  const copy = finishNotificationCopy({
    name: projectName(input.thread.cwd),
    threadName: input.thread.name,
    summary: input.thread.summary,
    count: 1,
    failed: input.outcome === "failed",
  });
  try {
    sendNotification({ title: copy.title, body: copy.body });
  } catch {
    // 系统拒绝通知时不影响线程运行。
  }
}
