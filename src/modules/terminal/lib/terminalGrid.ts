export const MAX_TERMINAL_VIEWS = 6;

/** 计算用户显式创建的终端视口布局，不自动填入其他终端。 */
export function terminalGrid(slots: (number | null)[]) {
  const viewSlots = slots.slice(0, MAX_TERMINAL_VIEWS);
  const count = Math.max(1, viewSlots.length);
  const columns = count <= 3 ? count : count === 4 ? 2 : 3;
  return {
    slots: viewSlots,
    visibleIds: viewSlots.filter((id): id is number => id !== null),
    columns,
    rows: Math.ceil(count / columns),
  };
}

/** 点击侧栏终端时只填入第一个空视口，已显示终端只聚焦。 */
export function fillTerminalViewport(
  slots: (number | null)[],
  id: number,
): (number | null)[] | null {
  if (slots.includes(id)) return [...slots];
  const empty = slots.indexOf(null);
  if (empty < 0) return null;
  const next = [...slots];
  next[empty] = id;
  return next;
}

/** 拖入指定视口时替换内容，并交换已经展示的终端避免重复。 */
export function placeTerminalInViewport(
  slots: (number | null)[],
  index: number,
  id: number,
): (number | null)[] {
  const next = [...slots];
  const previous = next.indexOf(id);
  if (previous >= 0 && previous !== index) next[previous] = next[index];
  next[index] = id;
  return next;
}
