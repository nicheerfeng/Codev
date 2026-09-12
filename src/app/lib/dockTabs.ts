export type DockTab = "terminal" | "json" | "diff" | "pi";

/** 将 Dock 标签按当前可见标签的间隙重排，隐藏插件仍保留在顺序列表中。 */
export function reorderDockTabsAtGap(
  tabs: DockTab[],
  visibleTabs: DockTab[],
  source: DockTab,
  gapIndex: number,
): DockTab[] {
  const remaining = visibleTabs.filter((tab) => tab !== source);
  const sourceIndex = visibleTabs.indexOf(source);
  if (sourceIndex < 0 || remaining.length === visibleTabs.length) return tabs;
  const boundedGap = Math.max(0, Math.min(gapIndex, visibleTabs.length));
  const gap = boundedGap - (sourceIndex < boundedGap ? 1 : 0);
  const target = remaining[gap] ?? remaining[remaining.length - 1];
  const next = tabs.filter((tab) => tab !== source);
  const targetIndex = next.indexOf(target);
  if (targetIndex < 0) return tabs;
  next.splice(
    gap === remaining.length ? targetIndex + 1 : targetIndex,
    0,
    source,
  );
  return next;
}

/** 根据鼠标横坐标计算 Dock header 当前拖拽标签的原始间隙。 */
export function dockDragGapIndex(header: HTMLElement, clientX: number): number {
  return [...header.querySelectorAll<HTMLElement>("[data-dock-tab]")].filter(
    (button) =>
      clientX >= button.getBoundingClientRect().left + button.offsetWidth / 2,
  ).length;
}
