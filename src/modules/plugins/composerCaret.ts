export type ComposerCaret = {
  start: number;
  end: number;
  scrollTop: number;
  height: number;
};

export const COMPOSER_MIN_HEIGHT = 96;
export const COMPOSER_DEFAULT_MAX = Math.round(COMPOSER_MIN_HEIGHT * 2.5);

const carets = new Map<string, ComposerCaret>();
let lastHeight = COMPOSER_DEFAULT_MAX;

/** 输入框可拉高到窗口一半，且不低于默认上限。 */
export function composerMaxHeight(): number {
  if (typeof window === "undefined") return 480;
  return Math.max(COMPOSER_DEFAULT_MAX, Math.floor(window.innerHeight * 0.5));
}

export function clampComposerHeight(height: number, cap = composerMaxHeight()) {
  return Math.min(cap, Math.max(COMPOSER_MIN_HEIGHT, Math.round(height)));
}

export function rememberComposer(
  key: string,
  node: HTMLTextAreaElement,
  height?: number,
) {
  const next = clampComposerHeight(
    height ?? carets.get(key)?.height ?? lastHeight,
  );
  carets.set(key, {
    start: node.selectionStart,
    end: node.selectionEnd,
    scrollTop: node.scrollTop,
    height: next,
  });
  lastHeight = next;
}

export function recallComposer(key: string): ComposerCaret | undefined {
  return carets.get(key);
}

export function composerHeight(key?: string) {
  return carets.get(key ?? "")?.height ?? lastHeight;
}

export function resetComposerHeight(key: string) {
  const saved = carets.get(key);
  if (saved) carets.set(key, { ...saved, height: COMPOSER_DEFAULT_MAX });
  lastHeight = COMPOSER_DEFAULT_MAX;
}

export function applyComposerHeight(node: HTMLTextAreaElement, cap: number) {
  const next = clampComposerHeight(cap);
  node.style.maxHeight = `${next}px`;
  // 先释放旧高度，否则 scrollHeight 至少等于上一次拉伸后的可视高度。
  node.style.height = "auto";
  node.style.height = `${Math.min(next, Math.max(COMPOSER_MIN_HEIGHT, node.scrollHeight))}px`;
}

export function restoreComposer(
  node: HTMLTextAreaElement,
  saved?: ComposerCaret,
) {
  const cap = saved?.height ?? lastHeight;
  applyComposerHeight(node, cap);
  if (!saved) return cap;
  const length = node.value.length;
  const start = Math.min(saved.start, length);
  const end = Math.min(saved.end, length);
  node.setSelectionRange(start, end);
  node.scrollTop = saved.scrollTop;
  return cap;
}
