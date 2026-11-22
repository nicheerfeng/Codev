import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const NOTIFY_KEY = "codev.agent.notify";
let permissionAsked = false;

export function agentNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAgentNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? "1" : "0");
  } catch {
    /* optional persistence */
  }
}

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

async function windowIsForeground(): Promise<boolean> {
  try {
    const win = getCurrentWindow();
    const [visible, focused, minimized] = await Promise.all([
      win.isVisible(),
      win.isFocused(),
      win.isMinimized(),
    ]);
    return visible && focused && !minimized && !document.hidden;
  } catch {
    return !document.hidden;
  }
}

export async function notifyAgentTurnFinished(input: {
  sessionTitle: string;
  workspaceTitle?: string;
  failed?: boolean;
  preview?: string;
}): Promise<void> {
  if (!agentNotifyEnabled()) return;
  if (await windowIsForeground()) return;
  if (!(await ensurePermission())) return;
  const project = input.workspaceTitle || "Agent 工作区";
  const title = input.failed
    ? `${project} · 执行失败`
    : `${project} · 回复完成`;
  const detail = [input.sessionTitle, input.preview]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 140);
  try {
    sendNotification({ title, body: detail || title });
  } catch {
    /* optional notification */
  }
}
