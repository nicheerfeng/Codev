import { create } from "zustand";
import type { PiComposerDropKind } from "./piComposerDrop";

type PiComposerDropState = {
  active: boolean;
  hover: boolean;
  setActive: (active: boolean) => void;
  setHover: (hover: boolean) => void;
  drop:
    | ((items: Array<{ path: string; kind: PiComposerDropKind }>) => void)
    | null;
  setDrop: (
    drop:
      | ((items: Array<{ path: string; kind: PiComposerDropKind }>) => void)
      | null,
  ) => void;
};

/** Pi 输入区是否接得住文件树拖入，由当前可见 composer 注册。 */
export const usePiComposerDropStore = create<PiComposerDropState>((set) => ({
  active: false,
  hover: false,
  setActive: (active) => set({ active }),
  setHover: (hover) =>
    set((state) => (state.hover === hover ? state : { hover })),
  drop: null,
  setDrop: (drop) => set({ drop }),
}));
