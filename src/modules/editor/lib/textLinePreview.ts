/** 将字节数转为紧凑文本，供大文件预览状态展示。 */
export function formatPreviewBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 把选中行映射成磁盘起点，供复制时按行读取全文。 */
export function collectLineOffsets(
  selectedIndexes: number[],
  lines: Array<{ offset: number }>,
): number[] {
  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .flatMap((index) => {
      const offset = lines[index]?.offset;
      return typeof offset === "number" ? [offset] : [];
    });
}

/** 收集与当前选区相交的行号。 */
export function selectedLineIndexes(
  root: ParentNode | null,
  selection: Selection | null,
): number[] {
  if (
    !root ||
    !selection ||
    selection.rangeCount === 0 ||
    selection.isCollapsed
  ) {
    return [];
  }
  const range = selection.getRangeAt(0);
  const indexes: number[] = [];
  for (const node of root.querySelectorAll<HTMLElement>("[data-line-index]")) {
    if (!range.intersectsNode(node)) continue;
    const index = Number(node.dataset.lineIndex);
    if (Number.isInteger(index)) indexes.push(index);
  }
  return indexes;
}
