/** 活跃项临时前置，同类保持原顺序，不修改保存的排序。 */
export function prioritizeActive<T>(
  items: T[],
  isActive: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
}

/** 将显示列表的拖拽落点映射回基础顺序，仅移动用户拖拽的项目。 */
export function moveDisplayedItem(
  base: string[],
  visible: string[],
  source: string,
  gap: number,
): string[] {
  const from = visible.indexOf(source);
  if (from < 0 || !base.includes(source)) return base;
  const bounded = Math.max(0, Math.min(gap, visible.length));
  if (bounded === from || bounded === from + 1) return base;
  const remaining = visible.filter((id) => id !== source);
  const to = bounded > from ? bounded - 1 : bounded;
  const next = base.filter((id) => id !== source);
  const after = remaining[to];
  const before = remaining[to - 1];
  const index = after
    ? next.indexOf(after)
    : before
      ? next.indexOf(before) + 1
      : 0;
  next.splice(index, 0, source);
  return next;
}
