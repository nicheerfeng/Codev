import { uiState } from "@/lib/uiState";

export const FILE_TREE_ROOTS_KEY = "codev.file-tree.roots";

/** 工作区根路径做成稳定键，Windows 盘符忽略大小写。 */
export function rootCollapseKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 读取根目录折叠集合；没有记录时视为首次，需要默认全折叠。 */
export function readFileTreeRootCollapsed(store?: Storage | null): {
  ready: boolean;
  keys: Set<string>;
} {
  try {
    const raw = (store ?? uiState).getItem(FILE_TREE_ROOTS_KEY);
    if (raw == null) return { ready: false, keys: new Set() };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ready: false, keys: new Set() };
    return {
      ready: true,
      keys: new Set(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map(rootCollapseKey),
      ),
    };
  } catch {
    return { ready: false, keys: new Set() };
  }
}

export function writeFileTreeRootCollapsed(
  keys: Iterable<string>,
  store?: Storage | null,
): void {
  try {
    (store ?? uiState).setItem(
      FILE_TREE_ROOTS_KEY,
      JSON.stringify([...keys].map(rootCollapseKey)),
    );
  } catch {
    /* storage unavailable */
  }
}

/** 只把新出现的根目录收起来，已记住的展开状态保持不变。 */
export function mergeNewCollapsedRoots(
  current: Iterable<string>,
  known: Iterable<string>,
  nextKeys: string[],
): { collapsed: Set<string>; known: Set<string>; changed: boolean } {
  const collapsed = new Set([...current].map(rootCollapseKey));
  const nextKnown = new Set([...known].map(rootCollapseKey));
  let changed = false;
  for (const key of nextKeys.map(rootCollapseKey)) {
    if (nextKnown.has(key)) continue;
    nextKnown.add(key);
    if (!collapsed.has(key)) {
      collapsed.add(key);
      changed = true;
    }
  }
  return { collapsed, known: nextKnown, changed };
}
