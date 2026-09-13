import { pathKey } from "./organization";

/** 按已保存顺序排列当前可见项，未知项追加到末尾。 */
export function applySavedOrder(values: string[], saved: string[]): string[] {
  const rank = new Map(saved.map((item, index) => [pathKey(item), index]));
  return [...values].sort((left, right) => {
    const a = rank.get(pathKey(left));
    const b = rank.get(pathKey(right));
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  });
}

/** 按间隙移动一项，语义与文件树根目录排序一致。 */
export function moveByGap(
  values: string[],
  source: string,
  gap: number,
): string[] {
  const from = values.findIndex((item) => pathKey(item) === pathKey(source));
  if (from < 0) return values;
  const bounded = Math.max(0, Math.min(gap, values.length));
  const to = bounded > from ? bounded - 1 : bounded;
  if (from === to) return values;
  const next = values.filter((_, index) => index !== from);
  next.splice(to, 0, values[from]);
  return next;
}

/** 把当前可见层的新顺序写回缓存，并保留其他层旧项。 */
export function mergeOrder(saved: string[], visible: string[]): string[] {
  const seen = new Set(visible.map(pathKey));
  return [...visible, ...saved.filter((item) => !seen.has(pathKey(item)))];
}

/** 读取损坏时回退为空数组的排序缓存。 */
export function readOrderList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          ),
        ),
      ]
    : [];
}
