export { TabBar, TabIcon } from "./TabBar";
export { TabSwitcherHud } from "./TabSwitcherHud";
export {
  useTabSwitcher,
  type TabSwitcherState,
} from "./lib/useTabSwitcher";
export { labelFor } from "./lib/tabLabel";
export {
  MAX_PANES_PER_TAB,
  DEFAULT_SPACE_ID,
  useTabs,
  nextActiveInSpace,
  planCloseTabsToRight,
  planCloseOtherTabs,
  type CloseTabsPlan,
  type Tab,
  type TerminalTab,
  type EditorTab,
  type PreviewTab,
  type MarkdownTab,
  type TabPatch,
} from "./lib/useTabs";
export { useWorkspaceCwd } from "./lib/useWorkspaceCwd";
export { useWorkspaceRoots } from "./lib/useWorkspaceRoots";
export { useWindowTitle } from "./lib/useWindowTitle";
