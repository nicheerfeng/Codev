import { invoke } from "@tauri-apps/api/core";

export type Resource = {
  alias: string;
  baseUrl: string;
  key: string;
};
export type ResourceCatalog = {
  provider: string;
  activeAlias: string;
  resources: Resource[];
  path: string;
};
export const RESOURCE_NOTE =
  "多视口或仍有任务运行时不可切换资源，请退出多视口并等待任务结束。";

/** 读取资源目录和当前配置对应的别名。 */
export function listResources(): Promise<ResourceCatalog> {
  return invoke("codex_resources_list");
}
/** 按原别名编辑资源；新增时不传原别名。 */
export function saveResource(input: Resource, originalAlias: string | null): Promise<ResourceCatalog> {
  return invoke("codex_resources_save", { input, originalAlias });
}
/** 删除指定别名的资源。 */
export function deleteResource(alias: string): Promise<ResourceCatalog> {
  return invoke("codex_resources_delete", { alias });
}
/** 查询指定资源的模型目录。 */
export function probeResource(alias: string): Promise<string> {
  return invoke("codex_resources_probe", { alias });
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

/** 读取 Codex 个人全局 AGENTS.md。 */
export function readCodexInstructions(): Promise<string> {
  return invoke("codex_resources_read_instructions");
}

/** 保存 Codex 个人全局 AGENTS.md。 */
export function writeCodexInstructions(content: string): Promise<void> {
  return invoke("codex_resources_write_instructions", { content });
}
