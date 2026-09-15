/** 按文件路径记住阅览器滚动位置，切标签卸载后仍能还原。 */

const positions = new Map<string, number>();

type ScrollTarget = {
  scrollTop: number;
  addEventListener: (
    type: "scroll",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (type: "scroll", listener: () => void) => void;
};

/** 记录当前滚动位置。 */
export function rememberFileScroll(path: string, top: number): void {
  if (!path) return;
  positions.set(path, top);
}

/** 取出上次滚动位置。 */
export function recallFileScroll(path: string): number | undefined {
  return positions.get(path);
}

/** 绑定滚动记忆：就绪后还原，滚动时写入，卸载时再记一次。 */
export function bindFileScroll(
  node: ScrollTarget | null,
  path: string,
  ready = true,
): () => void {
  if (!node || !path || !ready) return () => {};
  const saved = recallFileScroll(path);
  const restore = () => {
    if (saved !== undefined) node.scrollTop = saved;
  };
  restore();
  const later =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => {
          restore();
          requestAnimationFrame(restore);
        })
      : 0;
  const remember = () => rememberFileScroll(path, node.scrollTop);
  node.addEventListener("scroll", remember, { passive: true });
  return () => {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(later);
    }
    remember();
    node.removeEventListener("scroll", remember);
  };
}
