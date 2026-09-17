export const MAX_TERMINAL_VIEWS = 6;

/** 按终端顺序分页，组内切焦点不改变位置，跨组选择自动换页。 */
export function terminalGrid(ids: number[], activeId: number, count: number) {
  const capacity = Math.min(MAX_TERMINAL_VIEWS, Math.max(1, Math.floor(count)));
  const activeIndex = Math.max(0, ids.indexOf(activeId));
  const page = Math.floor(activeIndex / capacity);
  const visibleIds = ids.slice(page * capacity, (page + 1) * capacity);
  const displayed = Math.max(1, visibleIds.length);
  const columns = displayed <= 3 ? displayed : displayed === 4 ? 2 : 3;
  return {
    visibleIds,
    page,
    pages: Math.max(1, Math.ceil(ids.length / capacity)),
    columns,
    rows: Math.ceil(displayed / columns),
  };
}
