import { pathKey } from "./organization";
import type { PiViewStatus } from "./types";

export type ActivityThread = {
  cwd: string;
  status?: PiViewStatus;
  waiting?: boolean;
};

/** 压缩、排队等待和运行中都算 live，折叠项目要能看见。 */
export function threadIsLive(thread: ActivityThread): boolean {
  if (thread.waiting) return true;
  return (
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "stopping"
  );
}

/** 某个 cwd 下是否还有 live 线程，不受侧栏筛选和分页影响。 */
export function cwdIsLive(threads: ActivityThread[], cwd: string): boolean {
  const key = pathKey(cwd);
  return threads.some(
    (thread) => pathKey(thread.cwd) === key && threadIsLive(thread),
  );
}

export type ProjectActivity = {
  liveCount: number;
  failed: boolean;
};

/** 按项目聚合运行数，完成通知用。 */
export function projectActivity(
  threads: ActivityThread[],
): Map<string, ProjectActivity> {
  const result = new Map<string, ProjectActivity>();
  for (const thread of threads) {
    const key = pathKey(thread.cwd);
    if (!key) continue;
    const current = result.get(key) ?? { liveCount: 0, failed: false };
    if (threadIsLive(thread)) current.liveCount += 1;
    if (thread.status === "failed") current.failed = true;
    result.set(key, current);
  }
  return result;
}

/** 前台正看着 Pi 面板时不要弹系统通知。 */
export function shouldSkipFinishNotification(input: {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  piActive: boolean;
}): boolean {
  return input.visible && input.focused && !input.minimized && input.piActive;
}

export function finishNotificationCopy(input: {
  name: string;
  count: number;
  failed: boolean;
}): { title: string; body: string } {
  const name = input.name.trim() || "Pi";
  if (input.failed) {
    return {
      title: `Pi · ${name}`,
      body: input.count > 1 ? `${input.count} 个线程已失败` : "线程已失败",
    };
  }
  return {
    title: `Pi · ${name}`,
    body: input.count > 1 ? `${input.count} 个线程已完成` : "线程已完成",
  };
}
