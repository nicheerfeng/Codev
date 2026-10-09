import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { projectName } from "./paths";
import {
  finishNotificationCopy,
  shouldSkipFinishNotification,
  type ActivityThread,
} from "./projectActivity";

let permissionAsked = false;

/** 首次后台完成时申请系统通知权限。 */
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

/** 检查用户是否正在前台阅读 Codex。 */
async function codexPanelIsForeground(codexActive: boolean): Promise<boolean> {
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
      codexActive,
    });
  } catch {
    return false;
  }
}

/** Native interrupted turns never produce completion notifications. */
export async function notifyFinishedThread(input: {
  thread: ActivityThread;
  outcome: string;
  codexActive: boolean;
}): Promise<void> {
  if (!["completed", "failed"].includes(input.outcome)) return;
  if (await codexPanelIsForeground(input.codexActive)) return;
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
