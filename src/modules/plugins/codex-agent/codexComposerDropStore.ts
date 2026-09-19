import { create } from "zustand";
import type { CodexComposerDropKind } from "./codexComposerDrop";

type CodexComposerDropState = {
  active: boolean;
  hover: boolean;
  hoverKey: string | undefined;
  setActive: (active: boolean) => void;
  setHover: (hover: boolean, threadKey?: string) => void;
  drop:
    | ((
        items: Array<{ path: string; kind: CodexComposerDropKind }>,
        threadKey?: string,
      ) => void)
    | null;
  setDrop: (
    drop:
      | ((
          items: Array<{ path: string; kind: CodexComposerDropKind }>,
          threadKey?: string,
        ) => void)
      | null,
  ) => void;
};

/** Codex 输入区是否接得住文件树拖入，由当前可见 composer 注册。 */
export const useCodexComposerDropStore = create<CodexComposerDropState>(
  (set) => ({
    active: false,
    hover: false,
    hoverKey: undefined,
    setActive: (active) => set({ active }),
    setHover: (hover, hoverKey) =>
      set((state) =>
        state.hover === hover && state.hoverKey === hoverKey
          ? state
          : { hover, hoverKey },
      ),
    drop: null,
    setDrop: (drop) => set({ drop }),
  }),
);
