// Non-critical, single-window usage ranking. localStorage keeps it off the
// preferences store and its IPC change-broadcast path.

const KEY = "terax-palette-mru";
const MAX_ENTRIES = 120;

type MruMap = Record<string, number>;

function read(): MruMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MruMap) : {};
  } catch {
    return {};
  }
}

export function recordUse(id: string): void {
  const map = read();
  map[id] = Date.now();
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    for (const k of ids
      .sort((a, b) => map[a] - map[b])
      .slice(0, ids.length - MAX_ENTRIES)) {
      delete map[k];
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 清除本次工作区重置需要移除的命令面板历史排序。 */
export function clearMru(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function mruSnapshot(): MruMap {
  return read();
}

export function mruRank(snapshot: MruMap, id: string): number {
  return snapshot[id] ?? 0;
}
