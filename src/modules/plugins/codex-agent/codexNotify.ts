import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { pathKey, projectName } from "./paths";
import {
  finishNotificationCopy,
  shouldSkipFinishNotification,
  type ActivityThread,
  type ProjectActivity,
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

/** 项目从 live 变为全 idle 时弹一条 Windows 通知。 */
export async function notifyFinishedProjects(input: {
  previous: Map<string, ProjectActivity>;
  current: Map<string, ProjectActivity>;
  threads: ActivityThread[];
  codexActive: boolean;
}): Promise<void> {
  if (
    ![...input.previous].some(
      ([cwd, previous]) =>
        previous.liveCount > 0 && !input.current.get(cwd)?.liveCount,
    )
  )
    return;
  if (await codexPanelIsForeground(input.codexActive)) return;
  if (!(await ensurePermission())) return;
  for (const [cwd, previous] of input.previous) {
    if (previous.liveCount <= 0) continue;
    const current = input.current.get(cwd);
    if ((current?.liveCount ?? 0) > 0) continue;
    const sample =
      input.threads.find(
        (thread) => pathKey(thread.cwd) === cwd && thread.summary?.trim(),
      ) ?? input.threads.find((thread) => pathKey(thread.cwd) === cwd);
    const copy = finishNotificationCopy({
      name: sample ? projectName(sample.cwd) : cwd.split("/").pop() || cwd,
      threadName: sample?.name,
      summary: sample?.summary,
      count: previous.liveCount,
      failed: current?.failed ?? previous.failed,
    });
    try {
      sendNotification({ title: copy.title, body: copy.body });
    } catch {
      // 系统拒绝通知时不影响线程运行。
    }
  }
}
