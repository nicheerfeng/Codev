/** 按根目录间隙移动一项，保留其余路径顺序。 */
export function reorderRoots(roots: string[], source: string, gap: number): string[] {
  const from = roots.indexOf(source);
  if (from < 0) return roots;
  const bounded = Math.max(0, Math.min(gap, roots.length));
  const to = bounded > from ? bounded - 1 : bounded;
  if (from === to) return roots;
  const next = roots.filter((root) => root !== source);
  next.splice(to, 0, source);
  return next;
}
