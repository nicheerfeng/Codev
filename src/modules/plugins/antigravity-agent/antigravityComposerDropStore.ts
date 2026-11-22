import { create } from "zustand";

type DropHandler = (paths: string[], key?: string) => void;

type AntigravityComposerDropState = {
  active: boolean;
  hoverKey: string | undefined;
  drop: DropHandler | null;
  setActive: (active: boolean) => void;
  setHover: (hover: boolean, key?: string) => void;
  setDrop: (drop: DropHandler | null) => void;
};

/** 由当前可见的 Antigravity 输入区注册，文件树拖入时按 key 落到对应会话。 */
export const useAntigravityComposerDropStore =
  create<AntigravityComposerDropState>((set) => ({
    active: false,
    hoverKey: undefined,
    drop: null,
    setActive: (active) => set({ active }),
    setHover: (hover, key) =>
      set((state) =>
        state.hoverKey === (hover ? key : undefined)
          ? state
          : { hoverKey: hover ? key : undefined },
      ),
    setDrop: (drop) => set({ drop }),
  }));
