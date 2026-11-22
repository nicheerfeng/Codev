import { create } from "zustand";
import { toast } from "sonner";
import { usePluginStore } from "../store";
import {
  MAX_VIEWPORTS,
  clearViewportSlot,
  closeViewportSlot,
  growViewportSlots,
  swapViewportSlots,
} from "@/lib/viewportSlots";

function openWorkbench() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("codev:open-workbench"));
}

export type WorkbenchSource = {
  kind: "pi" | "codex" | "antigravity" | "terminal" | "browser";
  id: string;
  title: string;
};
export const sourceKey = (source: WorkbenchSource) =>
  `${source.kind}:${source.id}`;

type State = {
  slots: (WorkbenchSource | null)[];
  visible: boolean;
  moving: boolean;
  targets: Record<string, HTMLElement>;
  add: (source: WorkbenchSource) => boolean;
  clear: (index: number) => void;
  close: (index: number) => void;
  remove: (index: number) => void;
  swap: (from: number, to: number) => void;
  append: () => void;
  release: (kind: WorkbenchSource["kind"], id?: string) => void;
  rename: (kind: WorkbenchSource["kind"], id: string, title: string) => void;
  setTarget: (key: string, node: HTMLElement | null) => void;
};

export const useWorkbench = create<State>((set, get) => ({
  slots: [],
  visible: false,
  moving: false,
  targets: {},
  add: (source) => {
    if (!usePluginStore.getState().enabled.browser) return false;
    const slots = [...get().slots];
    if (slots.some((item) => item && sourceKey(item) === sourceKey(source))) {
      openWorkbench();
      return true;
    }
    const empty = slots.indexOf(null);
    if (empty >= 0) slots[empty] = source;
    else {
      toast.info("请先增加一个空视口，再放入内容");
      return false;
    }
    set({ slots });
    if (source.kind !== "browser") openWorkbench();
    return true;
  },
  clear: (index) => set({ slots: clearViewportSlot(get().slots, index, null) }),
  close: (index) => set({ slots: closeViewportSlot(get().slots, index) }),
  remove: (index) => get().clear(index),
  swap: (from, to) => {
    const slots = swapViewportSlots(get().slots, from, to);
    if (slots !== get().slots) set({ slots });
  },
  append: () => {
    if (get().slots.length >= MAX_VIEWPORTS)
      toast.info("工作台最多支持 6 个视口");
    else set({ slots: growViewportSlots(get().slots, null, MAX_VIEWPORTS) });
  },
  release: (kind, id) => {
    const slots = get().slots;
    if (
      !slots.some(
        (source) =>
          source?.kind === kind && (id === undefined || source.id === id),
      )
    )
      return;
    set({
      slots: slots.map((source) =>
        source?.kind === kind && (id === undefined || source.id === id)
          ? null
          : source,
      ),
    });
  },
  rename: (kind, id, title) => {
    const slots = get().slots;
    if (
      !slots.some(
        (source) =>
          source?.kind === kind && source.id === id && source.title !== title,
      )
    )
      return;
    set({
      slots: slots.map((source) =>
        source?.kind === kind && source.id === id
          ? { ...source, title }
          : source,
      ),
    });
  },
  setTarget: (key, node) => {
    if (get().targets[key] === node || (!node && !get().targets[key])) return;
    const targets = { ...get().targets };
    if (node) targets[key] = node;
    else delete targets[key];
    set({ targets });
  },
}));

usePluginStore.subscribe((state, previous) => {
  if (previous.enabled.browser && !state.enabled.browser) {
    useWorkbench.setState({
      slots: [],
      targets: {},
      visible: false,
      moving: false,
    });
  }
});
