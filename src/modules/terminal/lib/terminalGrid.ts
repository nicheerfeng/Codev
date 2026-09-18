export const MAX_TERMINAL_VIEWS = 6;

/** 只展示一组终端，选择未显示的已有终端时替换末尾视口。 */
export function terminalGrid(ids: number[], activeId: number, count: number) {
  const capacity = Math.min(MAX_TERMINAL_VIEWS, Math.max(1, Math.floor(count)));
  const visibleIds = ids.slice(0, capacity);
  if (ids.includes(activeId) && !visibleIds.includes(activeId))
    visibleIds[visibleIds.length - 1] = activeId;
  const displayed = Math.max(1, visibleIds.length);
  const columns = displayed <= 3 ? displayed : displayed === 4 ? 2 : 3;
  return {
    visibleIds,
    columns,
    rows: Math.ceil(displayed / columns),
  };
}
