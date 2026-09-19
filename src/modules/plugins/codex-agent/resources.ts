import { invoke } from "@tauri-apps/api/core";

export type Resource = {
  id: string;
  alias: string;
  baseUrl: string;
  keyMask: string;
};
export type ResourceCatalog = {
  provider: string;
  activeResourceId: string;
  resources: Resource[];
  path: string;
};
export const RESOURCE_NOTE =
  "多视口或仍有任务运行时不可切换资源，请退出多视口并等待任务结束。";

/** 读取只包含掩码密钥的资源目录。 */
export function listResources(): Promise<ResourceCatalog> {
  return invoke("codex_resources_list");
}
/** 保存档案，不修改正在运行的资源快照。 */
export function saveResource(input: {
  id: string;
  alias: string;
  baseUrl: string;
  key: string;
}): Promise<ResourceCatalog> {
  return invoke("codex_resources_save", { input });
}
/** 删除非当前资源。 */
export function deleteResource(id: string): Promise<ResourceCatalog> {
  return invoke("codex_resources_delete", { id });
}

/** 主动探测模型目录，不产生模型生成费用。 */
export function probeResource(id: string): Promise<string> {
  return invoke("codex_resources_probe", { id });
}

/** 将运行态汇总成可读的禁用原因，不因关闭视口漏掉后台会话。 */
export function resourceSwitchReason(
  multi: boolean,
  connected: boolean,
  switching: boolean,
  active: number,
  pending: number,
  unknown: boolean,
): string {
  if (switching) return "正在切换资源";
  if (multi) return "退出多视口后可切换资源";
  if (!connected || unknown) return "运行状态未知，请先重新连接 Codex";
  if (active) return `还有 ${active} 个任务运行或等待确认`;
  if (pending) return "正在处理请求，请稍后切换";
  return "";
}
