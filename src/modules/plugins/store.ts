import { create } from "zustand";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export const JSON_FORMATTER_PLUGIN_ID = "json-formatter" as const;
export type PluginId = typeof JSON_FORMATTER_PLUGIN_ID;

export type PluginState = {
  enabled: Record<PluginId, boolean>;
};

type PluginStoreState = PluginState & {
  hydrated: boolean;
  init: () => Promise<void>;
};

const STORE_PATH = "codev-plugins.json";
const ENABLED_PLUGINS_KEY = "enabledPlugins";
const PLUGIN_CHANGED_EVENT = "codev://plugin-settings-changed";
const DEFAULT_PLUGIN_STATE: PluginState = {
  enabled: { [JSON_FORMATTER_PLUGIN_ID]: false },
};
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
let initPromise: Promise<void> | null = null;

/** 规范化独立插件存储，未知插件配置不会进入运行时状态。 */
function normalizePluginState(value: unknown): PluginState {
  const enabled =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<PluginId, unknown>>)
      : {};
  return {
    enabled: {
      [JSON_FORMATTER_PLUGIN_ID]:
        enabled[JSON_FORMATTER_PLUGIN_ID] === true,
    },
  };
}

/** 读取插件独立配置文件，避免把插件状态混入常规设置。 */
export async function loadPluginState(): Promise<PluginState> {
  const value = await store.get<unknown>(ENABLED_PLUGINS_KEY);
  return normalizePluginState(value ?? DEFAULT_PLUGIN_STATE.enabled);
}

/** 持久化插件开关并通知主窗口与设置窗口同步状态。 */
export async function setPluginEnabled(
  id: PluginId,
  enabled: boolean,
): Promise<void> {
  const current = await loadPluginState();
  const next = { ...current.enabled, [id]: enabled };
  await store.set(ENABLED_PLUGINS_KEY, next);
  await store.save();
  usePluginStore.setState({ enabled: next });
  await emit(PLUGIN_CHANGED_EVENT, { id, enabled });
}

/** 监听其他窗口发来的插件开关变化。 */
export async function onPluginStateChange(
  callback: (id: PluginId, enabled: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; enabled: boolean }>(
    PLUGIN_CHANGED_EVENT,
    (event) => {
      if (event.payload.id !== JSON_FORMATTER_PLUGIN_ID) return;
      callback(JSON_FORMATTER_PLUGIN_ID, event.payload.enabled === true);
    },
  );
}

/** 提供插件配置的跨窗口响应式状态。 */
export const usePluginStore = create<PluginStoreState>((set) => ({
  ...DEFAULT_PLUGIN_STATE,
  hydrated: false,
  init: () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        set({ ...(await loadPluginState()), hydrated: true });
        await onPluginStateChange((id, enabled) =>
          set((state) => ({ enabled: { ...state.enabled, [id]: enabled } })),
        );
      } catch (error) {
        initPromise = null;
        throw error;
      }
    })();
    return initPromise;
  },
}));
