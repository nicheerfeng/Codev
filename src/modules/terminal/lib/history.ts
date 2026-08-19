import { invoke } from "@tauri-apps/api/core";

// 查询后端保存的终端命令历史，供命令面板复用。
export function historyList(query: string, limit = 200): Promise<string[]> {
  return invoke<string[]>("history_list", { query, limit }).catch(() => []);
}
