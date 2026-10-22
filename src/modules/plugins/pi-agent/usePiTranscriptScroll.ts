import { useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PiTimelineBlock } from "./timeline";
import {
  capFollow,
  followAfterScroll,
  FOLLOW_FREEZE_GAP,
  isNearBottom,
  readingBlockIndex,
  readingMeasurements,
  type PiReadingPosition,
  type PiScrollMemory,
} from "./transcriptScroll";

/** Own restoration, measurement and user scroll intent in one place. */
export function usePiTranscriptScroll({
  threadKey,
  positions,
  blocks,
  active,
  loading,
  sendRevision,
  historyLoadingMore,
  historyHasMore,
  followCap,
  followCapIndex,
  onLoadOlder,
}: {
  threadKey: string;
  positions: Map<string, PiScrollMemory>;
  blocks: PiTimelineBlock[];
  active: boolean;
  loading: boolean;
  sendRevision: number;
  historyLoadingMore: boolean;
  historyHasMore: boolean;
  /** 停住跟随插件是否开启。 */
  followCap: boolean;
  followCapIndex?: number;
  onLoadOlder?: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [memory] = useState<PiScrollMemory>(
    () => positions.get(threadKey) ?? { top: 0, follow: true },
  );
  const [expanded] = useState(
    () => memory.expanded ?? new Map<string, boolean>(),
  );
  const follow = useRef(memory.follow);
  const [following, setFollowing] = useState(memory.follow);
  const capped = useRef(memory.capped ?? false);
  const restoring = useRef<PiReadingPosition | null>(null);
  const userUntil = useRef(0);
  const loadingOlder = useRef(false);
  const seenSend = useRef(sendRevision);
  const wasVisible = useRef(false);
  const wake = useRef(() => {});
  const live = useRef({
    active,
    loading,
    blocks,
    historyLoadingMore,
    historyHasMore,
    followCapIndex,
    onLoadOlder,
  });
  live.current = {
    active,
    loading,
    blocks,
    historyLoadingMore,
    historyHasMore,
    followCapIndex,
    onLoadOlder,
  };
  const [initialMeasurements] = useState(() =>
    readingMeasurements(blocks, memory),
  );
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => viewport.current,
    getItemKey: (index) => blocks[index].id,
    estimateSize: () => 110,
    initialOffset: memory.follow ? 0 : memory.top,
    initialMeasurementsCache: initialMeasurements,
    // Keep measurements on plugin hide. The visible geometry guard below freezes writes.
    enabled: true,
    overscan: 4,
    useAnimationFrameWithResizeObserver: true,
    useFlushSync: false,
  });
  // 只在「停住跟随」插件开启时接管：本轮结束会换块 key，首帧只有估算高度，
  // 按估算尺寸补偿会把停住的视野推到底。插件关闭时保留虚拟列表默认行为。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = followCap
    ? (item, _delta, instance) =>
        instance.itemSizeCache.has(item.key) &&
        item.end <= (instance.scrollOffset ?? 0)
    : undefined;

  /** measure() 只清缓存；正文宽度未变时 RO 不会再报尺寸，必须补测已挂载行。 */
  const remeasureVisibleRows = () => {
    virtualizer.measure();
    // 先重建估算位置，否则 resizeItem 会把旧尺寸当作未变化而跳过写回。
    virtualizer.getTotalSize();
    for (const row of content.current?.querySelectorAll<HTMLElement>(
      "[data-index]",
    ) ?? []) {
      if (row.isConnected && row.offsetHeight > 0)
        virtualizer.resizeItem(Number(row.dataset.index), row.offsetHeight);
    }
  };

  const visible = () => {
    const node = viewport.current;
    return (
      live.current.active &&
      !!node &&
      node.clientHeight > 0 &&
      node.clientWidth > 0 &&
      node.getClientRects().length > 0
    );
  };
  const capture = (): PiReadingPosition | null => {
    const node = viewport.current;
    if (!node || !visible()) return null;
    const top = node.scrollTop;
    const row = virtualizer.getVirtualItemForOffset(top);
    const position: PiReadingPosition = { top, follow: follow.current };
    if (!row) return position;
    position.anchor = { blockId: String(row.key), offset: top - row.start };
    const element = content.current?.querySelector<HTMLElement>(
      `[data-index="${row.index}"]`,
    );
    if (element) {
      const rect = node.getBoundingClientRect();
      const scale = rect.height / node.offsetHeight || 1;
      const items = [
        ...element.querySelectorAll<HTMLElement>("[data-pi-text]"),
      ];
      const item = items.find((entry) => {
        const box = entry.getBoundingClientRect();
        return box.height > 0 && box.bottom > rect.top;
      });
      if (item) {
        position.anchor.itemId = item.dataset.piText;
        position.anchor.itemOffset =
          (rect.top - item.getBoundingClientRect().top) / scale;
      }
    }
    return position;
  };
  const remember = () => {
    if (
      !wasVisible.current ||
      restoring.current ||
      live.current.loading ||
      live.current.historyLoadingMore ||
      !visible()
    )
      return;
    const node = viewport.current;
    const position = capture();
    if (!position || !node) return;
    if (!follow.current) {
      for (const detail of content.current?.querySelectorAll<HTMLDetailsElement>(
        "[data-pi-expansion]",
      ) ?? []) {
        const id = detail.dataset.piExpansion;
        if (id) expanded.set(id, detail.open);
      }
    }
    Object.assign(memory, position, {
      width: node.clientWidth,
      measurements: virtualizer.takeSnapshot(),
      expanded,
    });
    memory.anchor = position.anchor;
    positions.set(threadKey, memory);
  };
  const pinBottom = () => {
    const node = viewport.current;
    if (!node || !visible() || isNearBottom(node)) return;
    if (!live.current.blocks.length) return;
    virtualizer.scrollToIndex(live.current.blocks.length - 1, {
      align: "end",
    });
  };
  const bottom = () => {
    restoring.current = null;
    userUntil.current = 0;
    capped.current = false;
    memory.capped = false;
    follow.current = true;
    setFollowing(true);
    memory.follow = true;
    memory.top = 0;
    memory.anchor = undefined;
    positions.set(threadKey, memory);
    pinBottom();
  };
  /** 回答块几何：首行偏移与自身高度，都按容器缩放换算。 */
  const answerGeometry = () => {
    const index = live.current.followCapIndex;
    const node = viewport.current;
    if (index === undefined || !node) return undefined;
    const element = content.current?.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    if (!element) return undefined;
    const rect = node.getBoundingClientRect();
    const scale = rect.height / node.offsetHeight || 1;
    const box = element.getBoundingClientRect();
    return {
      top: (box.top - rect.top) / scale,
      height: box.height / scale,
      viewport: node.clientHeight,
    };
  };
  /**
   * 只在真正贴底的那一帧判定停住：pinBottom 的滚动下一帧才落地，
   * 同一帧量几何会拿到「还没滚动」的位置，导致在顶部就提前停住。
   */
  const capGeometry = () => {
    const node = viewport.current;
    if (!node || !isNearBottom(node)) return undefined;
    const geometry = answerGeometry();
    return geometry && capFollow(geometry) ? geometry : undefined;
  };
  /** 首行刚被顶出就停住，并对齐到视口顶部下方一点，让读者从第一行开始。 */
  const holdFollow = (offset: number) => {
    capped.current = true;
    memory.capped = true;
    follow.current = false;
    setFollowing(false);
    const node = viewport.current;
    if (node) {
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      const target = Math.max(
        0,
        Math.min(node.scrollTop + offset - FOLLOW_FREEZE_GAP, max),
      );
      virtualizer.scrollToOffset(target);
    }
    remember();
  };
  /** A gesture, not a programmatic scroll event, gives control back to the reader. */
  const interact = () => {
    restoring.current = null;
    loadingOlder.current = false;
    // Cancel any outstanding virtualizer scroll-to-index reconciliation.
    if (viewport.current)
      virtualizer.scrollToOffset(viewport.current.scrollTop);
    follow.current = false;
    setFollowing(false);
    userUntil.current = performance.now() + 1000;
    remember();
  };
  /** 用户在拖滚动条或向下滚时，让 onScroll 判断是否贴回底部。 */
  const armUserScroll = () => {
    restoring.current = null;
    userUntil.current = performance.now() + 1000;
  };
  const loadEarlier = () => {
    const node = viewport.current;
    const state = live.current;
    if (
      !node ||
      restoring.current ||
      !visible() ||
      node.scrollTop >= 80 ||
      !state.historyHasMore ||
      state.loading ||
      state.historyLoadingMore ||
      loadingOlder.current ||
      !state.onLoadOlder
    )
      return;
    remember();
    // Prepending uses the same identity anchor, not a difference of two estimated totals.
    restoring.current = {
      top: memory.top,
      follow: false,
      anchor: memory.anchor && { ...memory.anchor },
    };
    loadingOlder.current = true;
    state.onLoadOlder();
    wake.current();
  };
  const onScroll = () => {
    if (
      !visible() ||
      restoring.current ||
      live.current.loading ||
      live.current.historyLoadingMore
    )
      return;
    const node = viewport.current;
    if (!node) return;
    const userScrolling = performance.now() < userUntil.current;
    if (userScrolling) userUntil.current = performance.now() + 200;
    const atBottom = isNearBottom(node);
    const next = followAfterScroll(atBottom, userScrolling, follow.current);
    follow.current = next;
    setFollowing(next);
    if (userScrolling && !next) loadEarlier();
    remember();
  };

  const latest = useRef({ remember, pinBottom, visible, bottom });
  latest.current = { remember, pinBottom, visible, bottom };
  useLayoutEffect(() => {
    memory.expanded = expanded;
    positions.set(threadKey, memory);
    let frame = 0;
    let stable = 0;
    let attempts = 0;
    let previousTarget = Number.NaN;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const finishRestore = () => {
      restoring.current = null;
      loadingOlder.current = false;
      userUntil.current = 0;
      stable = 0;
      attempts = 0;
      latest.current.remember();
    };
    const tick = () => {
      frame = 0;
      if (!latest.current.visible()) {
        wasVisible.current = false;
        return;
      }
      const node = viewport.current;
      if (!node) return;
      if (!wasVisible.current) {
        wasVisible.current = true;
        stable = 0;
        attempts = 0;
        restoring.current = {
          top: memory.top,
          follow: memory.follow,
          anchor: memory.anchor && { ...memory.anchor },
        };
        follow.current = memory.follow;
        setFollowing(memory.follow);
        if (
          memory.width !== undefined &&
          Math.abs(memory.width - node.clientWidth) > 1
        )
          remeasureVisibleRows();
      }
      if (live.current.loading || live.current.historyLoadingMore) return;
      const position = restoring.current;
      if (position) {
        if (!live.current.blocks.length) return;
        if (position.follow) {
          latest.current.pinBottom();
          finishRestore();
          return;
        }
        const index = readingBlockIndex(live.current.blocks, position);
        const row =
          index >= 0 ? virtualizer.measurementsCache[index] : undefined;
        let target = position.top;
        if (row && position.anchor) {
          target =
            row.start +
            Math.min(position.anchor.offset, Math.max(0, row.size - 1));
          const element = content.current?.querySelector<HTMLElement>(
            `[data-index="${index}"]`,
          );
          const item =
            element &&
            [...element.querySelectorAll<HTMLElement>("[data-pi-text]")].find(
              (entry) =>
                entry.dataset.piText === position.anchor?.itemId &&
                entry.getBoundingClientRect().height > 0,
            );
          if (item && position.anchor.itemOffset !== undefined) {
            const rect = node.getBoundingClientRect();
            const scale = rect.height / node.offsetHeight || 1;
            target =
              node.scrollTop +
              (item.getBoundingClientRect().top - rect.top) / scale +
              position.anchor.itemOffset;
          }
        }
        const reachable = Math.max(
          0,
          Math.min(target, node.scrollHeight - node.clientHeight),
        );
        if (Math.abs(node.scrollTop - reachable) > 1)
          virtualizer.scrollToOffset(target);
        const mounted =
          index < 0 ||
          !!content.current?.querySelector(`[data-index="${index}"]`);
        stable =
          mounted &&
          Math.abs(previousTarget - reachable) < 1 &&
          Math.abs(node.scrollTop - reachable) < 1
            ? stable + 1
            : 0;
        previousTarget = reachable;
        attempts += 1;
        if (stable < 3 && attempts < 12) {
          schedule();
          return;
        }
        finishRestore();
      }
    };
    wake.current = schedule;
    schedule();
    // No DOM read on cleanup: a hidden/unmounted viewport can already report a clamped zero.
    return () => {
      cancelAnimationFrame(frame);
      wake.current = () => {};
    };
  }, [threadKey, positions, memory, expanded, virtualizer]);

  useLayoutEffect(() => {
    if (sendRevision !== seenSend.current) {
      seenSend.current = sendRevision;
      latest.current.bottom();
    }
    if (!visible()) {
      wasVisible.current = false;
      return;
    }
    wake.current();
    if (loading || restoring.current || !wasVisible.current) return;
    if (follow.current) {
      pinBottom();
      const geometry = capGeometry();
      if (geometry) holdFollow(geometry.top);
    }
    remember();
  });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (!latest.current.visible()) {
        wasVisible.current = false;
        return;
      }
      if (restoring.current || !wasVisible.current) return;
      if (
        memory.width !== undefined &&
        Math.abs(memory.width - node.clientWidth) > 1 &&
        !follow.current
      ) {
        restoring.current = {
          top: memory.top,
          follow: false,
          anchor: memory.anchor && { ...memory.anchor },
        };
        remeasureVisibleRows();
        wake.current();
        return;
      }
      if (follow.current) latest.current.pinBottom();
      latest.current.remember();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return {
    viewport,
    content,
    virtualizer,
    following,
    expanded,
    bottom,
    interact,
    armUserScroll,
    loadEarlier,
    onScroll,
  };
}
