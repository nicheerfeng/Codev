import { create } from "zustand";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  EMPTY_ORGANIZATION,
  normalizeOrganization,
  type PiOrganization,
} from "./pi-agent/organization";
import { readOrderList } from "./pi-agent/sidebarOrder";
import type { PiModel } from "./pi-agent/types";

export const JSON_FORMATTER_PLUGIN_ID = "json-formatter" as const;
export const TEXT_DIFF_PLUGIN_ID = "text-diff" as const;
export const PI_AGENT_PLUGIN_ID = "pi-agent" as const;
export const CODEX_AGENT_PLUGIN_ID = "codex-agent" as const;
export type PluginId =
  | typeof JSON_FORMATTER_PLUGIN_ID
  | typeof TEXT_DIFF_PLUGIN_ID
  | typeof PI_AGENT_PLUGIN_ID
  | typeof CODEX_AGENT_PLUGIN_ID;

export type PluginState = {
  enabled: Record<PluginId, boolean>;
  piAgentProjects: string[];
  piAgentHiddenProjects: string[];
  piAgentOrganization: PiOrganization;
  piAgentLastModel: PiModel | null;
  piAgentLastThinkingLevel: string;
  piAgentProjectOrder: string[];
  piAgentSessionOrder: string[];
};

type PluginStoreState = PluginState & {
  hydrated: boolean;
  init: () => Promise<void>;
};

const STORE_PATH = "codev-plugins.json";
const ENABLED_PLUGINS_KEY = "enabledPlugins";
const PI_AGENT_PROJECTS_KEY = "piAgentProjects";
const PI_AGENT_HIDDEN_PROJECTS_KEY = "piAgentHiddenProjects";
const PI_AGENT_LAST_MODEL_KEY = "piAgentLastModel";
const PI_AGENT_LAST_THINKING_KEY = "piAgentLastThinkingLevel";
const PI_AGENT_PROJECT_ORDER_KEY = "piAgentProjectOrder";
const PI_AGENT_SESSION_ORDER_KEY = "piAgentSessionOrder";
const PLUGIN_CHANGED_EVENT = "codev://plugin-settings-changed";
const DEFAULT_PLUGIN_STATE: PluginState = {
  enabled: {
    [JSON_FORMATTER_PLUGIN_ID]: false,
    [TEXT_DIFF_PLUGIN_ID]: false,
    [PI_AGENT_PLUGIN_ID]: false,
    [CODEX_AGENT_PLUGIN_ID]: false,
  },
  piAgentProjects: [],
  piAgentHiddenProjects: [],
  piAgentOrganization: EMPTY_ORGANIZATION,
  piAgentLastModel: null,
  piAgentLastThinkingLevel: "off",
  piAgentProjectOrder: [],
  piAgentSessionOrder: [],
};
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
let initPromise: Promise<void> | null = null;

/** 规范化独立插件存储，未知插件配置不会进入运行时状态。 */
/** 规范化插件开关、Pi Agent 项目目录和已隐藏项目。 */
function normalizePluginState(
  value: unknown,
  projects: unknown = [],
  hiddenProjects: unknown = [],
  lastModel: unknown = null,
  lastThinkingLevel: unknown = "off",
): PluginState {
  const enabled =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<PluginId, unknown>>)
      : {};
  const model =
    lastModel && typeof lastModel === "object" && !Array.isArray(lastModel)
      ? (lastModel as Partial<PiModel>)
      : null;
  return {
    piAgentOrganization: EMPTY_ORGANIZATION,
    enabled: {
      [JSON_FORMATTER_PLUGIN_ID]: enabled[JSON_FORMATTER_PLUGIN_ID] === true,
      [TEXT_DIFF_PLUGIN_ID]: enabled[TEXT_DIFF_PLUGIN_ID] === true,
      [PI_AGENT_PLUGIN_ID]: enabled[PI_AGENT_PLUGIN_ID] === true,
      [CODEX_AGENT_PLUGIN_ID]: enabled[CODEX_AGENT_PLUGIN_ID] === true,
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
    piAgentLastModel:
      typeof model?.provider === "string" && typeof model.id === "string"
        ? {
            provider: model.provider,
            id: model.id,
            name: typeof model.name === "string" ? model.name : undefined,
          }
        : null,
    piAgentLastThinkingLevel:
      typeof lastThinkingLevel === "string" && lastThinkingLevel.trim()
        ? lastThinkingLevel
        : "off",
    piAgentProjectOrder: [],
    piAgentSessionOrder: [],
  };
}

/** 读取插件独立配置文件，避免把插件状态混入常规设置。 */
async function loadPluginState(): Promise<PluginState> {
  const value = await store.get<unknown>(ENABLED_PLUGINS_KEY);
  const projects = await store.get<unknown>(PI_AGENT_PROJECTS_KEY);
  const hiddenProjects = await store.get<unknown>(PI_AGENT_HIDDEN_PROJECTS_KEY);
  const lastModel = await store.get<unknown>(PI_AGENT_LAST_MODEL_KEY);
  const lastThinkingLevel = await store.get<unknown>(
    PI_AGENT_LAST_THINKING_KEY,
  );
  const state = normalizePluginState(
    value ?? DEFAULT_PLUGIN_STATE.enabled,
    projects,
    hiddenProjects,
    lastModel,
    lastThinkingLevel,
  );
  return {
    ...state,
    piAgentOrganization: normalizeOrganization(
      await store.get<unknown>("piAgentOrganization"),
    ),
    piAgentProjectOrder: readOrderList(
      await store.get<unknown>(PI_AGENT_PROJECT_ORDER_KEY),
    ),
    piAgentSessionOrder: readOrderList(
      await store.get<unknown>(PI_AGENT_SESSION_ORDER_KEY),
    ),
  };
}

/** 记住 Pi 项目拖拽顺序，重启后按缓存排列。 */
export async function setPiAgentProjectOrder(order: string[]): Promise<void> {
  const next = readOrderList(order);
  await store.set(PI_AGENT_PROJECT_ORDER_KEY, next);
  await store.save();
  usePluginStore.setState({ piAgentProjectOrder: next });
}

/** 记住 Pi session 拖拽顺序，归档项不写入此缓存。 */
export async function setPiAgentSessionOrder(
  order: string[] | ((current: string[]) => string[]),
): Promise<void> {
  const next = readOrderList(
    typeof order === "function"
      ? order(usePluginStore.getState().piAgentSessionOrder)
      : order,
  );
  usePluginStore.setState({ piAgentSessionOrder: next });
  await store.set(PI_AGENT_SESSION_ORDER_KEY, next);
  await store.save();
}

/** 记住最近一次思考等级，新线程直接复用。 */
export async function setPiAgentLastThinkingLevel(
  level: string,
): Promise<void> {
  await store.set(PI_AGENT_LAST_THINKING_KEY, level);
  await store.save();
  usePluginStore.setState({ piAgentLastThinkingLevel: level });
}

/** 记住最近一次选用的模型，新线程不必先启动 runtime。 */
export async function setPiAgentLastModel(
  model: PiModel | null,
): Promise<void> {
  await store.set(PI_AGENT_LAST_MODEL_KEY, model);
  await store.save();
  usePluginStore.setState({ piAgentLastModel: model });
}

/** 保存 Pi 组和归档展示信息，不修改 Pi 原生会话。 */
export async function setPiAgentOrganization(
  next: PiOrganization,
): Promise<void> {
  const normalized = normalizeOrganization(next);
  await store.set("piAgentOrganization", normalized);
  await store.save();
  usePluginStore.setState({ piAgentOrganization: normalized });
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
async function onPluginStateChange(
  callback: (id: PluginId, enabled: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; enabled: boolean }>(
    PLUGIN_CHANGED_EVENT,
    (event) => {
      if (
        event.payload.id !== JSON_FORMATTER_PLUGIN_ID &&
        event.payload.id !== TEXT_DIFF_PLUGIN_ID &&
        event.payload.id !== PI_AGENT_PLUGIN_ID &&
        event.payload.id !== CODEX_AGENT_PLUGIN_ID
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
