import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("codev-ui-state.json", {
  defaults: {},
  autoSave: false,
});
const values = new Map<string, string>();
const legacyKeys = [
  "codev.sidebar.width",
  "codev.sidebar.collapsed",
  "codev.terminal.width",
  "codev.terminal.collapsed",
  "codev.pi.sidebar.collapsed",
  "codev.file-tree.roots",
  "codev.file-tree.expanded",
  "codev.welcome.completed",
  "codev.welcome.stamp",
  "codev.layout.initialized",
];
let writes = Promise.resolve();

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/** 首次绘制前读取统一 SQLite 状态库（非 Tauri 测试环境回落到 LazyStore），仅在缺项时迁移旧记录。 */
export async function initUiState(
  legacy: Pick<Storage, "getItem"> = localStorage,
): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const fromDb = await invoke<Record<string, string>>("app_db_ui_load_all");
      for (const [key, value] of Object.entries(fromDb)) {
        if (typeof value === "string") values.set(key, value);
      }
      if (values.size === 0) {
        const entries = await store.entries<unknown>().catch(() => []);
        for (const [key, value] of entries) {
          if (typeof value !== "string" || values.has(key)) continue;
          values.set(key, value);
          await invoke("app_db_ui_set", { key, value });
        }
      }
      for (const key of legacyKeys) {
        if (values.has(key)) continue;
        const value = legacy.getItem(key);
        if (value === null) continue;
        values.set(key, value);
        await invoke("app_db_ui_set", { key, value });
      }
      return;
    } catch (error) {
      console.warn("SQLite 界面状态读取失败，回落到文件存储", error);
    }
  }
  const entries = await store.entries<unknown>();
  for (const [key, value] of entries) {
    if (typeof value === "string") values.set(key, value);
  }
  for (const key of legacyKeys) {
    if (values.has(key)) continue;
    const value = legacy.getItem(key);
    if (value === null) continue;
    values.set(key, value);
    await store.set(key, value);
  }
  await store.save();
}

export const uiState = {
  /** 同步读取启动时已加载的布局值，避免首帧恢复闪动。 */
  getItem(key: string): string | null {
    return values.get(key) ?? null;
  },
  /** 内存立即更新，SQLite 写入串行执行，避免快速拖拽覆盖新值。 */
  setItem(key: string, value: string): void {
    if (values.get(key) === value) return;
    values.set(key, value);
    writes = writes
      .then(async () => {
        if (isTauriRuntime()) {
          try {
            await invoke("app_db_ui_set", { key, value });
            return;
          } catch (error) {
            console.warn("SQLite 保存界面状态失败，回落到文件存储", error);
          }
        }
        await store.set(key, value);
        await store.save();
      })
      .catch((error) => console.error("保存界面状态失败", error));
  },
};

/** 等待界面记忆落盘，供退出和回归核验使用。 */
export function flushUiState(): Promise<void> {
  return writes;
}
