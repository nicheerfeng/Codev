/** 按文件路径记住阅览器滚动位置，切标签卸载后仍能还原。 */

const positions = new Map<string, number>();
const restoring = new Set<string>();

type ScrollTarget = {
  scrollTop: number;
  scrollHeight?: number;
  addEventListener: (
    type: "scroll",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (type: "scroll", listener: () => void) => void;
};

export type BindFileScrollOptions = {
  ready?: boolean;
  /** 在布局完成后再调用 apply；返回取消函数。 */
  schedule?: (apply: () => void) => () => void;
};

/** 记录当前滚动位置；还原期间忽略框架自己的归零。 */
export function rememberFileScroll(path: string, top: number): void {
  if (!path || restoring.has(path)) return;
  positions.set(path, top);
}

/** 取出上次滚动位置。 */
export function recallFileScroll(path: string): number | undefined {
  return positions.get(path);
}

/** 开始还原：这段时间的 scroll=0 不写入记忆。 */
export function beginFileScrollRestore(path: string): void {
  if (path) restoring.add(path);
}

/** 结束还原，之后的滚动视为用户操作。 */
export function endFileScrollRestore(path: string): void {
  restoring.delete(path);
}

function defaultSchedule(apply: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    apply();
    return () => {};
  }
  const id = requestAnimationFrame(() => apply());
  return () => cancelAnimationFrame(id);
}

/** 等滚动容器高度够放下保存位置后再还原。 */
export function scheduleWhenTallEnough(
  getNode: () => { scrollHeight: number } | null,
  saved: number | undefined,
  apply: () => void,
): () => void {
  let cancelled = false;
  let frames = 0;
  const tryApply = () => {
    if (cancelled) return;
    const node = getNode();
    frames += 1;
    if (
      saved &&
      saved > 0 &&
      frames < 30 &&
      node &&
      node.scrollHeight < saved
    ) {
      requestAnimationFrame(tryApply);
      return;
    }
    apply();
  };
  if (typeof requestAnimationFrame !== "function") {
    apply();
    return () => {
      cancelled = true;
    };
  }
  requestAnimationFrame(tryApply);
  return () => {
    cancelled = true;
  };
}

/** 绑定滚动记忆：布局后再还原，还原期间不把归零写进 Map。 */
export function bindFileScroll(
  node: ScrollTarget | null,
  path: string,
  options: boolean | BindFileScrollOptions = true,
): () => void {
  const ready =
    typeof options === "boolean" ? options : (options.ready ?? true);
  const schedule =
    typeof options === "boolean"
      ? defaultSchedule
      : (options.schedule ?? defaultSchedule);
  if (!node || !path || !ready) return () => {};
  let cancelled = false;
  beginFileScrollRestore(path);
  const saved = recallFileScroll(path);
  const apply = () => {
    if (cancelled) return;
    if (saved !== undefined) node.scrollTop = saved;
    endFileScrollRestore(path);
  };
  const remember = () => rememberFileScroll(path, node.scrollTop);
  node.addEventListener("scroll", remember, { passive: true });
  const stopSchedule = schedule(apply);
  return () => {
    cancelled = true;
    stopSchedule();
    const wasRestoring = restoring.has(path);
    endFileScrollRestore(path);
    if (!wasRestoring) remember();
    node.removeEventListener("scroll", remember);
  };
}
