export const PI_SIDEBAR_COLLAPSED_KEY = "codev.pi.sidebar.collapsed";

/** 读取 Pi 侧栏折叠集合；没有记录时视为首次，需要默认全折叠。 */
export function readPiCollapsed(): { ready: boolean; keys: Set<string> } {
  try {
    const raw = localStorage.getItem(PI_SIDEBAR_COLLAPSED_KEY);
    if (raw == null) return { ready: false, keys: new Set() };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ready: false, keys: new Set() };
    return {
      ready: true,
      keys: new Set(
        parsed.filter((item): item is string => typeof item === "string"),
      ),
    };
  } catch {
    return { ready: false, keys: new Set() };
  }
}

export function writePiCollapsed(keys: Iterable<string>): void {
  try {
    localStorage.setItem(PI_SIDEBAR_COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* storage unavailable */
  }
}

/** 只把新出现的组和项目收起来，已记住的展开状态保持不变。 */
export function mergeNewCollapsedKeys(
  current: Iterable<string>,
  known: Iterable<string>,
  nextKeys: string[],
): { collapsed: Set<string>; known: Set<string>; changed: boolean } {
  const collapsed = new Set(current);
  const nextKnown = new Set(known);
  let changed = false;
  for (const key of nextKeys) {
    if (nextKnown.has(key)) continue;
    nextKnown.add(key);
    if (!collapsed.has(key)) {
      collapsed.add(key);
      changed = true;
    }
  }
  return { collapsed, known: nextKnown, changed };
}
