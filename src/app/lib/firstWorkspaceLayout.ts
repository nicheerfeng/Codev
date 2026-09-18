import { FILE_TREE_ROOTS_KEY } from "@/modules/explorer/lib/rootCollapse";
import { uiState } from "@/lib/uiState";
import { SIDEBAR_MIN_WIDTH } from "@/modules/sidebar/useSidebarPanel";
import { TERMINAL_MIN_WIDTH } from "@/modules/terminal/lib/useTerminalPanelLayout";

export const WELCOME_KEY = "codev.welcome.completed";
export const WELCOME_STAMP_KEY = "codev.welcome.stamp";
export const LAYOUT_INITIALIZED_KEY = "codev.layout.initialized";
export const FILE_TREE_EXPANDED_KEY = "codev.file-tree.expanded";
export { FILE_TREE_ROOTS_KEY };
export const SIDEBAR_WIDTH_KEY = "codev.sidebar.width";
export const SIDEBAR_COLLAPSED_KEY = "codev.sidebar.collapsed";
export const TERMINAL_WIDTH_KEY = "codev.terminal.width";
export const TERMINAL_COLLAPSED_KEY = "codev.terminal.collapsed";

type MemoryStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 首次进入工作区时按视口算出约三等分的左右栏宽度。 */
export function firstLayoutSizes(width: number): {
  sidebar: number;
  terminal: number;
} {
  const usable = Math.max(900, Math.round(width));
  return {
    sidebar: Math.max(SIDEBAR_MIN_WIDTH, Math.round(usable / 3)),
    terminal: Math.max(TERMINAL_MIN_WIDTH, Math.round(usable / 3)),
  };
}

/** 还没按视口写过左右栏宽度时，需要走一次首次三栏。 */
export function needsFirstLayout(store: MemoryStore | null = uiState): boolean {
  try {
    return !store || store.getItem(LAYOUT_INITIALIZED_KEY) !== "1";
  } catch {
    return true;
  }
}

/** 仅未完成初始化时显示欢迎页，安装升级不重置已有布局。 */
export function shouldShowWelcome(
  _stamp: string | null,
  store: MemoryStore | null = uiState,
): boolean {
  try {
    if (!store || store.getItem(WELCOME_KEY) !== "1") return true;
    return needsFirstLayout(store);
  } catch {
    return true;
  }
}

/** 写入欢迎完成和首次三栏宽度，左栏展开、右栏展开。 */
export function completeWelcome(
  stamp: string | null,
  width = 1200,
  store: MemoryStore | null = uiState,
): { sidebar: number; terminal: number } {
  const sizes = firstLayoutSizes(width);
  try {
    store?.setItem(WELCOME_KEY, "1");
    if (stamp) store?.setItem(WELCOME_STAMP_KEY, stamp);
    store?.setItem(LAYOUT_INITIALIZED_KEY, "1");
    store?.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    store?.setItem(TERMINAL_COLLAPSED_KEY, "0");
    store?.setItem(SIDEBAR_WIDTH_KEY, String(sizes.sidebar));
    store?.setItem(TERMINAL_WIDTH_KEY, String(sizes.terminal));
    store?.setItem(FILE_TREE_EXPANDED_KEY, "{}");
  } catch {
    /* storage unavailable */
  }
  return sizes;
}
