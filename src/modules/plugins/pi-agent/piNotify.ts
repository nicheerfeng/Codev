import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { pathKey, projectName } from "./organization";
import {
  finishNotificationCopy,
  projectActivity,
  shouldSkipFinishNotification,
  type ActivityThread,
  type ProjectActivity,
} from "./projectActivity";

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

/** 项目从 live 变为全 idle 时弹一条 Windows 通知。 */
export async function notifyFinishedProjects(input: {
  previous: Map<string, ProjectActivity>;
  threads: ActivityThread[];
  piActive: boolean;
}): Promise<Map<string, ProjectActivity>> {
  const next = projectActivity(input.threads);
  if (await piPanelIsForeground(input.piActive)) return next;
  if (!(await ensurePermission())) return next;
  for (const [cwd, previous] of input.previous) {
    if (previous.liveCount <= 0) continue;
    const current = next.get(cwd);
    if ((current?.liveCount ?? 0) > 0) continue;
    const sample = input.threads.find((thread) => pathKey(thread.cwd) === cwd);
    const copy = finishNotificationCopy({
      name: sample ? projectName(sample.cwd) : cwd.split("/").pop() || cwd,
      count: previous.liveCount,
      failed: current?.failed ?? previous.failed,
    });
    try {
      sendNotification({ title: copy.title, body: copy.body });
    } catch {
      // 系统拒绝通知时不影响线程运行。
    }
  }
  return next;
}
