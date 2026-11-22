import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export const JSON_FORMATTER_PLUGIN_ID = "json-formatter" as const;
export const TEXT_DIFF_PLUGIN_ID = "text-diff" as const;
export const AGENT_HOST_PLUGIN_ID = "agent-host" as const;
export const TASKBAR_UNREAD_PLUGIN_ID = "taskbar-unread" as const;
export type PluginId =
  | typeof JSON_FORMATTER_PLUGIN_ID
  | typeof TEXT_DIFF_PLUGIN_ID
  | typeof AGENT_HOST_PLUGIN_ID
  | typeof TASKBAR_UNREAD_PLUGIN_ID;
export type PluginState = { enabled: Record<PluginId, boolean> };
type State = PluginState & { hydrated: boolean; init: () => Promise<void> };
const FILE = new LazyStore("codev-plugins.json", {
  defaults: {},
  autoSave: 200,
});
const EVENT = "codev://plugin-settings-changed";
const IDS: PluginId[] = [
  JSON_FORMATTER_PLUGIN_ID,
  TEXT_DIFF_PLUGIN_ID,
  AGENT_HOST_PLUGIN_ID,
  TASKBAR_UNREAD_PLUGIN_ID,
];
let initialization: Promise<void> | null = null;
function normalize(value: unknown): PluginState["enabled"] {
  const old =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    "json-formatter": old[JSON_FORMATTER_PLUGIN_ID] === true,
    "text-diff": old[TEXT_DIFF_PLUGIN_ID] === true,
    "agent-host":
      typeof old[AGENT_HOST_PLUGIN_ID] === "boolean"
        ? old[AGENT_HOST_PLUGIN_ID] === true
        : old["pi-agent"] === true ||
          old["codex-agent"] === true ||
          old["antigravity-agent"] === true,
    "taskbar-unread": old[TASKBAR_UNREAD_PLUGIN_ID] !== false,
  };
}
export const usePluginStore = create<State>((set) => ({
  enabled: normalize(null),
  hydrated: false,
  init: () => {
    if (initialization) return initialization;
    initialization = (async () => {
      const saved = await FILE.get<unknown>("enabledPlugins");
      set({ enabled: normalize(saved), hydrated: true });
      await listen<{ id: PluginId; enabled: boolean }>(EVENT, ({ payload }) => {
        if (IDS.includes(payload.id))
          set((s) => ({
            enabled: { ...s.enabled, [payload.id]: payload.enabled === true },
          }));
      });
    })().catch((e) => {
      initialization = null;
      throw e;
    });
    return initialization;
  },
}));
export async function setPluginEnabled(
  id: PluginId,
  enabled: boolean,
): Promise<void> {
  const saved = await FILE.get<Record<string, unknown>>("enabledPlugins");
  const next = { ...normalize(saved), [id]: enabled };
  // Old native preferences remain on disk for one-time metadata import / recovery.
  await FILE.set("enabledPlugins", next);
  await FILE.save();
  usePluginStore.setState({ enabled: next });
  await emit(EVENT, { id, enabled });
}
