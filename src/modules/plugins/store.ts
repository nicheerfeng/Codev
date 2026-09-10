import { create } from "zustand";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  EMPTY_ORGANIZATION,
  type PiOrganization,
} from "./pi-agent/organization";

export const JSON_FORMATTER_PLUGIN_ID = "json-formatter" as const;
export const TEXT_DIFF_PLUGIN_ID = "text-diff" as const;
export const PI_AGENT_PLUGIN_ID = "pi-agent" as const;
export type PluginId =
  | typeof JSON_FORMATTER_PLUGIN_ID
  | typeof TEXT_DIFF_PLUGIN_ID
  | typeof PI_AGENT_PLUGIN_ID;

export type PluginState = {
  enabled: Record<PluginId, boolean>;
  piAgentProjects: string[];
  piAgentHiddenProjects: string[];
  piAgentOrganization: PiOrganization;
};

type PluginStoreState = PluginState & {
  hydrated: boolean;
  init: () => Promise<void>;
};

const STORE_PATH = "codev-plugins.json";
const ENABLED_PLUGINS_KEY = "enabledPlugins";
const PI_AGENT_PROJECTS_KEY = "piAgentProjects";
const PI_AGENT_HIDDEN_PROJECTS_KEY = "piAgentHiddenProjects";
const PLUGIN_CHANGED_EVENT = "codev://plugin-settings-changed";
const DEFAULT_PLUGIN_STATE: PluginState = {
  enabled: {
    [JSON_FORMATTER_PLUGIN_ID]: false,
    [TEXT_DIFF_PLUGIN_ID]: false,
    [PI_AGENT_PLUGIN_ID]: false,
  },
  piAgentProjects: [],
  piAgentHiddenProjects: [],
  piAgentOrganization: EMPTY_ORGANIZATION,
};
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
let initPromise: Promise<void> | null = null;

/** 规范化独立插件存储，未知插件配置不会进入运行时状态。 */
/** 规范化插件开关、Pi Agent 项目目录和已隐藏项目。 */
function normalizePluginState(
  value: unknown,
  projects: unknown = [],
  hiddenProjects: unknown = [],
): PluginState {
  const enabled =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<PluginId, unknown>>)
      : {};
  return {
    piAgentOrganization: EMPTY_ORGANIZATION,
    enabled: {
      [JSON_FORMATTER_PLUGIN_ID]: enabled[JSON_FORMATTER_PLUGIN_ID] === true,
      [TEXT_DIFF_PLUGIN_ID]: enabled[TEXT_DIFF_PLUGIN_ID] === true,
      [PI_AGENT_PLUGIN_ID]: enabled[PI_AGENT_PLUGIN_ID] === true,
    },
    piAgentProjects: Array.isArray(projects)
      ? [
          ...new Set(
            projects
              .filter(
                (item): item is string =>
                  typeof item === "string" && item.trim().length > 0,
              )
              .map((item) => item.replace(/\\/g, "/")),
          ),
        ]
      : [],
    piAgentHiddenProjects: Array.isArray(hiddenProjects)
      ? [
          ...new Set(
            hiddenProjects
              .filter(
                (item): item is string =>
                  typeof item === "string" && item.trim().length > 0,
              )
              .map((item) => item.replace(/\\/g, "/")),
          ),
        ]
      : [],
  };
}

/** 读取插件独立配置文件，避免把插件状态混入常规设置。 */
export async function loadPluginState(): Promise<PluginState> {
  const value = await store.get<unknown>(ENABLED_PLUGINS_KEY);
  const projects = await store.get<unknown>(PI_AGENT_PROJECTS_KEY);
  const hiddenProjects = await store.get<unknown>(PI_AGENT_HIDDEN_PROJECTS_KEY);
  const state = normalizePluginState(
    value ?? DEFAULT_PLUGIN_STATE.enabled,
    projects,
    hiddenProjects,
  );
  return {
    ...state,
    piAgentOrganization:
      (await store.get<PiOrganization>("piAgentOrganization")) ??
      EMPTY_ORGANIZATION,
  };
}

/** 保存 Pi 组和归档展示信息，不修改 Pi 原生会话。 */
export async function setPiAgentOrganization(
  next: PiOrganization,
): Promise<void> {
  await store.set("piAgentOrganization", next);
  await store.save();
  usePluginStore.setState({ piAgentOrganization: next });
}

/** 持久化 Pi Agent 的项目目录列表，不写入常规设置。 */
export async function setPiAgentProjects(projects: string[]): Promise<void> {
  const next = [...new Set(projects.map((item) => item.replace(/\\/g, "/")))];
  await store.set(PI_AGENT_PROJECTS_KEY, next);
  await store.save();
  usePluginStore.setState({ piAgentProjects: next });
}

/** 持久化 Pi Agent 中被用户隐藏的自动项目分组。 */
export async function setPiAgentHiddenProjects(
  projects: string[],
): Promise<void> {
  const next = [...new Set(projects.map((item) => item.replace(/\\/g, "/")))];
  await store.set(PI_AGENT_HIDDEN_PROJECTS_KEY, next);
  await store.save();
  usePluginStore.setState({ piAgentHiddenProjects: next });
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
      if (
        event.payload.id !== JSON_FORMATTER_PLUGIN_ID &&
        event.payload.id !== TEXT_DIFF_PLUGIN_ID &&
        event.payload.id !== PI_AGENT_PLUGIN_ID
      )
        return;
      callback(event.payload.id, event.payload.enabled === true);
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
