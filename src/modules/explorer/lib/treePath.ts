/** 统一文件树与 watcher 事件路径，便于父目录刷新对齐。 */
export function normalizeTreePath(path: string): string {
  let value = path.replace(/\\/g, "/");
  if (value.startsWith("//?/UNC/")) value = `//${value.slice(8)}`;
  else if (value.startsWith("//?/")) value = value.slice(4);
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(value)) value = `${value}/`;
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith("//"))
    return value.toLowerCase();
  return value;
}

/** 取规范化后的父目录，保留 Windows 盘符根。 */
export function parentTreePath(path: string): string {
  const value = normalizeTreePath(path);
  if (/^[a-z]:\/$/i.test(value) || value === "/" || value === "") return value;
  const index = value.lastIndexOf("/");
  if (index <= 0) return "/";
  const parent = value.slice(0, index);
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
}

/** 在已加载节点里找出与目标路径同一目录的实际键。 */
export function findLoadedTreePath(
  nodes: Record<string, { status: string }>,
  path: string,
): string | null {
  const target = normalizeTreePath(path);
  for (const [key, state] of Object.entries(nodes)) {
    if (state.status === "loaded" && normalizeTreePath(key) === target)
      return key;
  }
  return null;
}

/** 从变更路径向上找到当前树中最近的已加载祖先，含根目录。 */
export function closestLoadedTreePath(
  nodes: Record<string, { status: string }>,
  path: string,
  rootPath: string | null,
): string | null {
  if (!rootPath) return findLoadedTreePath(nodes, parentTreePath(path));
  const root = normalizeTreePath(rootPath);
  let current = normalizeTreePath(path);
  while (current === root || current.startsWith(`${root}/`)) {
    const loaded = findLoadedTreePath(nodes, current);
    if (loaded) return loaded;
    const parent = parentTreePath(current);
    if (parent === current) break;
    current = parent;
  }
  return findLoadedTreePath(nodes, parentTreePath(path));
}
