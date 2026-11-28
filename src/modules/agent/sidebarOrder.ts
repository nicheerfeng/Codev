/** 新进入运行的项写到保存顺序最前，结束后不再跳回原位。 */
export function promoteLiveOrder(saved: string[], liveIds: string[]): string[] {
  if (!liveIds.length) return saved;
  const rank = new Map(saved.map((item, index) => [item, index]));
  const next = saved.filter((item) => !liveIds.includes(item));
  const ordered = [...liveIds].sort(
    (left, right) => (rank.get(left) ?? -1) - (rank.get(right) ?? -1),
  );
  return [...ordered, ...next];
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
