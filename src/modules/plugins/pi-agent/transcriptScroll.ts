import { createContext, useCallback, useContext, useReducer } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { PiTimelineBlock } from "./timeline";

export type PiReadingPosition = {
  top: number;
  follow: boolean;
  anchor?: {
    blockId: string;
    itemId?: string;
    offset: number;
    itemOffset?: number;
  };
};

export type PiScrollMemory = PiReadingPosition & {
  width?: number;
  measurements?: VirtualItem[];
  expanded?: Map<string, boolean>;
  /** 本轮已经停住过跟随，重新发送或点「回到最新」才解除。 */
  capped?: boolean;
};

export type PiFollowGeometry = {
  /** 回答顶部相对视口顶部的偏移，负值表示首行已滑出视口。 */
  top: number;
  /** 回答块已渲染的高度。 */
  height: number;
  /** 视口高度。 */
  viewport: number;
};

/**
 * 首行被顶到视口顶部、且回答已能填满一屏时停住。
 * 未测量的行被虚拟列表摆在内容顶端，只靠偏移会误触，所以必须同时看高度。
 */
export function capFollow({ top, height, viewport }: PiFollowGeometry) {
  return height >= viewport && top <= 0;
}

/** 停住时首行上方留出的呼吸空间（行本身还有 8px 内边距）。 */
export const FOLLOW_FREEZE_GAP = 16;

/** 跟随预算只挂在正在生成的回答块上，用户消息和纯工具块不触发停住。 */
export function followCapBlockIndex(
  blocks: PiTimelineBlock[],
  running: boolean,
) {
  if (!running) return undefined;
  const index = blocks.length - 1;
  const block = blocks[index];
  if (!block) return undefined;
  const items = block.kind === "process" ? block.items : [block.item];
  return items.some(
    (item) => item.kind === "message" && item.role === "assistant",
  )
    ? index
    : undefined;
}

/** 贴底则跟随；只有用户正在滚动且离开底部才暂停，程序滚动不能改跟随。 */
export function followAfterScroll(
  atBottom: boolean,
  userScrolling: boolean,
  follow: boolean,
) {
  if (atBottom) return true;
  if (userScrolling) return false;
  return follow;
}

/** 已在底部附近时不要再写 scrollTop，避免测量循环。 */
export function isNearBottom(
  node: { scrollHeight: number; clientHeight: number; scrollTop: number },
  slack = 32,
) {
  return node.scrollHeight - node.clientHeight - node.scrollTop < slack;
}

/** Resolve by message identity as a streaming message can move out of its process block. */
export function readingBlockIndex(
  blocks: PiTimelineBlock[],
  position: PiReadingPosition,
) {
  const anchor = position.anchor;
  if (!anchor) return -1;
  if (anchor.itemId) {
    const index = blocks.findIndex((block) =>
      block.kind === "item"
        ? block.item.id === anchor.itemId
        : block.items.some((item) => item.id === anchor.itemId),
    );
    if (index >= 0) return index;
  }
  return blocks.findIndex((block) => block.id === anchor.blockId);
}

/** Remap cached sizes by stable key after history prepend or streaming block changes. */
export function readingMeasurements(
  blocks: PiTimelineBlock[],
  memory?: PiScrollMemory,
) {
  const sizes = new Map(
    memory?.measurements?.map((item) => [item.key, item.size]),
  );
  let start = 0;
  return blocks.flatMap((block, index) => {
    const size = sizes.get(block.id);
    const item = {
      key: block.id,
      index,
      start,
      size: size ?? 110,
      end: start + (size ?? 110),
      lane: 0,
    };
    start = item.end;
    return size === undefined ? [] : [item];
  });
}

export const PiExpansionContext = createContext<Map<string, boolean> | null>(
  null,
);

/** User overrides survive virtual row unmounts; untouched processes still follow running state. */
export function usePiExpansion(id: string, defaultValue = false) {
  const memory = useContext(PiExpansionContext);
  const [, update] = useReducer((value: number) => value + 1, 0);
  const expanded = memory?.get(id) ?? defaultValue;
  const setExpanded = useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      const previous = memory?.get(id) ?? defaultValue;
      const value = typeof next === "function" ? next(previous) : next;
      memory?.set(id, value);
      update();
    },
    [memory, id, defaultValue],
  );
  return [expanded, setExpanded] as const;
}
