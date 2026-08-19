import { invoke } from "@tauri-apps/api/core";

/** 打开单页面设置窗口。 */
export async function openSettingsWindow(): Promise<void> {
  await invoke("open_settings_window");
}
