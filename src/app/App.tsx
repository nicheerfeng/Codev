import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  consumeLaunchFiles,
  consumePendingOpenTargets,
  getExplicitLaunchDir,
  getLaunchDir,
  type OpenTargetPayload,
} from "@/lib/launchDir";
import { isHtmlPath, isMarkdownPath } from "@/lib/utils";
import { useZoom } from "@/lib/useZoom";
import { quoteShellArg } from "@/lib/shellQuote";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  type ReaderFileDropKind,
  useReaderFileDrop,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  shouldDisablePaneSwapShortcut,
  type ShortcutHandlers,
  type ShortcutId,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import { SIDEBAR_MIN_WIDTH, useSidebarPanel } from "@/modules/sidebar";
import {
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import {
  TabSwitcherHud,
  type CloseTabsPlan,
  type Tab,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
  useWorkspaceRoots,
} from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  disposeSession,
  hasLeaf,
  leafIds,
  TerminalPanel,
  type PaneBounds,
  type TerminalPaneHandle,
  TERMINAL_MIN_WIDTH,
  useTerminalPanelLayout,
  useTerminalFileDrop,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CloseDialogs } from "./components/CloseDialogs";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

/** 判断文件标签是否对应同一个规范化路径。 */
function tabPathMatches(tab: Tab, path: string): boolean {
  if (
    tab.kind !== "editor" &&
    tab.kind !== "markdown" &&
    tab.kind !== "html"
  )
    return false;
  return tab.path.replace(/\\/g, "/") === path.replace(/\\/g, "/");
}

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    reorderTabByGroup,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    openFileTab,
    pinTab,
    newMarkdownTab,
    newHtmlTab,
    setMarkdownView,
    setHtmlView,
    setOverrideLanguage,
    closeTab,
    closeTabs,
    updateTab,
    rebasePaths,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const editorHandleOwners = useRef<
    Map<number, "editor" | "markdown" | "html">
  >(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [primaryEditorActiveId, setPrimaryEditorActiveId] = useState<
    number | null
  >(null);
  const [secondaryEditorIds, setSecondaryEditorIds] = useState<number[]>([]);
  const [secondaryEditorActiveId, setSecondaryEditorActiveId] = useState<
    number | null
  >(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    searchAddons.current.clear();
    terminalRefs.current.clear();
    editorRefs.current.clear();
    editorHandleOwners.current.clear();
    setActiveSearchAddon(null);
    setActiveEditorHandle(null);
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const { home, launchCwd, launchCwdResolved, adoptWorkspaceEnv } =
    useWorkspaceSwitcher({
      tabsRef,
      workspaceEnv,
      setWorkspaceEnv,
      resetWorkspace,
      clearWorkspaceState,
    });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  const activeSpaceIdRef = useRef(activeSpaceId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    activeSpaceIdRef.current = activeSpaceId;
  }, [tabs, activeId, activeSpaceId]);

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly); else fall to the space's last tab.
    if (inSpace.some((t) => t.id === activeId)) return;
    setActiveId(inSpace[inSpace.length - 1].id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const workspaceTabs = tabs;

  const {
    sidebarRef,
    sidebarWidthRef,
    initialSidebarCollapsed,
    persistSidebarCollapsed,
    toggleSidebar,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );

  const activeTab = tabs.find((t) => t.id === activeId);

  // Terminal tabs live in the right-side dock panel; file tabs are assigned to
  // one of the two fixed editor groups in the central workspace.
  const fileTabs = useMemo(
    () => workspaceTabs.filter((t) => t.kind !== "terminal"),
    [workspaceTabs],
  );
  const terminalTabs = useMemo(
    () => workspaceTabs.filter((t) => t.kind === "terminal"),
    [workspaceTabs],
  );
  const lastTerminalTabIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeTab?.kind === "terminal") {
      lastTerminalTabIdRef.current = activeId;
    }
  }, [activeTab, activeId]);
  const terminalActiveId =
    activeTab?.kind === "terminal"
      ? activeId
      : (lastTerminalTabIdRef.current ??
        terminalTabs[terminalTabs.length - 1]?.id ??
        -1);

  const secondaryEditorIdSet = useMemo(
    () => new Set(secondaryEditorIds),
    [secondaryEditorIds],
  );
  const primaryEditorTabs = useMemo(
    () => fileTabs.filter((tab) => !secondaryEditorIdSet.has(tab.id)),
    [fileTabs, secondaryEditorIdSet],
  );
  const secondaryEditorTabs = useMemo(
    () => fileTabs.filter((tab) => secondaryEditorIdSet.has(tab.id)),
    [fileTabs, secondaryEditorIdSet],
  );
  const primaryActiveId = primaryEditorTabs.some(
    (tab) => tab.id === primaryEditorActiveId,
  )
    ? (primaryEditorActiveId ?? -1)
    : (primaryEditorTabs[primaryEditorTabs.length - 1]?.id ?? -1);
  const secondaryActiveId = secondaryEditorTabs.some(
    (tab) => tab.id === secondaryEditorActiveId,
  )
    ? (secondaryEditorActiveId ?? -1)
    : (secondaryEditorTabs[secondaryEditorTabs.length - 1]?.id ?? -1);

  useEffect(() => {
    const live = new Set(fileTabs.map((tab) => tab.id));
    setSecondaryEditorIds((ids) => {
      const next = ids.filter((id) => live.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [fileTabs]);

  const selectPrimaryEditor = useCallback(
    (id: number) => {
      setPrimaryEditorActiveId(id);
      setActiveId(id);
    },
    [setActiveId],
  );

  const selectSecondaryEditor = useCallback(
    (id: number) => {
      setSecondaryEditorActiveId(id);
      setActiveId(id);
    },
    [setActiveId],
  );

  const focusEditor = useCallback(
    (id: number) => {
      if (secondaryEditorIdSet.has(id)) selectSecondaryEditor(id);
      else selectPrimaryEditor(id);
    },
    [secondaryEditorIdSet, selectPrimaryEditor, selectSecondaryEditor],
  );

  const moveEditorToGroup = useCallback(
    (id: number, group: "primary" | "secondary") => {
      if (group === "secondary") {
        setSecondaryEditorIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
        setSecondaryEditorActiveId(id);
        setActiveId(id);
        return;
      }
      setSecondaryEditorIds((ids) => ids.filter((item) => item !== id));
      setPrimaryEditorActiveId(id);
      setActiveId(id);
    },
    [setActiveId],
  );

  const reorderPrimaryEditors = useCallback(
    (fromId: number, toGapIndex: number) => {
      reorderTabByGroup(
        primaryEditorTabs.map((tab) => tab.id),
        fromId,
        toGapIndex,
      );
    },
    [primaryEditorTabs, reorderTabByGroup],
  );

  const reorderSecondaryEditors = useCallback(
    (fromId: number, toGapIndex: number) => {
      reorderTabByGroup(
        secondaryEditorTabs.map((tab) => tab.id),
        fromId,
        toGapIndex,
      );
    },
    [reorderTabByGroup, secondaryEditorTabs],
  );

  /** 在终端导航分组内按目标间隙持久重排终端标签。 */
  const reorderTerminals = useCallback(
    (fromId: number, toGapIndex: number) => {
      reorderTabByGroup(
        terminalTabs.map((tab) => tab.id),
        fromId,
        toGapIndex,
      );
    },
    [reorderTabByGroup, terminalTabs],
  );

  const {
    terminalPanelRef,
    terminalWidthRef,
    initialTerminalCollapsed,
    terminalPanelCollapsed,
    persistTerminalCollapsed,
    persistTerminalWidth,
    expandTerminalPanel,
  } = useTerminalPanelLayout();
  const previousTerminalCountRef = useRef(0);
  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    if (terminalTabs.length === 0) {
      panel.collapse();
      previousTerminalCountRef.current = 0;
      return;
    }
    if (
      previousTerminalCountRef.current === 0 ||
      terminalTabs.length > previousTerminalCountRef.current
    ) {
      expandTerminalPanel();
    }
    previousTerminalCountRef.current = terminalTabs.length;
  }, [expandTerminalPanel, terminalTabs.length]);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isSearchableDocumentTab =
    activeTab?.kind === "editor" ||
    activeTab?.kind === "markdown" ||
    (activeTab?.kind === "html" && activeTab.viewMode === "raw");

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const {
    roots: workspaceRoots,
    activeRoot,
    addRoot,
    removeRoot,
    renameRoot: renameWorkspaceRoot,
    setActiveRoot,
  } = useWorkspaceRoots();

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
    activeRoot ?? workspaceRoots[0] ?? null,
  );

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      editorHandleOwners.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const disposeTabs = useCallback(
    (anchorId: number, plan: CloseTabsPlan) => {
      const closedIds = closeTabs(anchorId, plan);
      for (const id of closedIds) {
        editorRefs.current.delete(id);
        editorHandleOwners.current.delete(id);
      }
    },
    [closeTabs],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRightInGroup,
    handleCloseOtherTabsInGroup,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathDeleted,
  } = useTabCloseGuards({
    tabs,
    activeId,
    disposeTab,
    disposeTabs,
  });

  const { pendingAppClose, confirmAppClose, cancelAppClose } =
    useAppCloseGuard(tabsRef);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const inSpace = tabsRef.current.map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown and HTML tabs keep their own view mode and start rendered.
      const id = isMarkdownPath(path)
        ? newMarkdownTab(path)
        : isHtmlPath(path)
          ? newHtmlTab(path)
          : openFileTab(path, pin ?? true);
      if (secondaryEditorIdSet.has(id)) selectSecondaryEditor(id);
      else selectPrimaryEditor(id);
      return id;
    },
    [
      newMarkdownTab,
      newHtmlTab,
      openFileTab,
      secondaryEditorIdSet,
      selectPrimaryEditor,
      selectSecondaryEditor,
    ],
  );

  const handleOpenFileToSide = useCallback(
    (path: string) => {
      const existing = secondaryEditorTabs.find((tab) =>
        tabPathMatches(tab, path),
      );
      const id =
        existing?.id ??
        (isHtmlPath(path)
          ? newHtmlTab(path, { activate: false, allowDuplicate: true })
          : openFileTab(path, true, {
              activate: false,
              allowDuplicate: true,
            }));
      setSecondaryEditorIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      setSecondaryEditorActiveId(id);
      setActiveId(id);
      return id;
    },
    [newHtmlTab, openFileTab, secondaryEditorTabs, setActiveId],
  );

  /** 在指定阅览器中以临时标签打开外部拖入文件。 */
  const openDroppedFile = useCallback(
    (
      path: string,
      group: "primary" | "secondary",
      kind: ReaderFileDropKind,
    ) => {
      if (kind === "dir") {
        void addRoot(path);
        return;
      }
      const id = isMarkdownPath(path)
        ? newMarkdownTab(path)
        : isHtmlPath(path)
          ? newHtmlTab(path, { activate: group === "primary" })
          : openFileTab(path, false, {
              activate: group === "primary",
            });
      if (group === "secondary") {
        setSecondaryEditorIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
        setSecondaryEditorActiveId(id);
      } else {
        setPrimaryEditorActiveId(id);
      }
      setActiveId(id);
    },
    [addRoot, newHtmlTab, newMarkdownTab, openFileTab, setActiveId],
  );

  useReaderFileDrop({ onOpen: openDroppedFile });

  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  /** 将外部目录加入当前工作区，并打开同次传入的文件。 */
  const applyOpenTarget = useCallback(
    async (target: OpenTargetPayload) => {
      if (target.dir) await addRoot(target.dir.replace(/\\/g, "/"));
      for (const path of target.files) handleOpenFile(path, true);
    },
    [addRoot, handleOpenFile],
  );

  const launchRootAppliedRef = useRef(false);
  useEffect(() => {
    const dir = getExplicitLaunchDir();
    if (!booted || launchRootAppliedRef.current || !dir) return;
    launchRootAppliedRef.current = true;
    void addRoot(dir);
  }, [addRoot, booted]);

  useEffect(() => {
    if (!booted) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const drainPendingTargets = async () => {
      const targets = await consumePendingOpenTargets();
      if (disposed) return;
      for (const target of targets) await applyOpenTarget(target);
    };

    void listen("codev:open-target", () => {
      void drainPendingTargets();
    }).then((off) => {
      if (disposed) off();
      else {
        unlisten = off;
        void drainPendingTargets();
      }
    });
    void drainPendingTargets();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyOpenTarget, booted]);

  // Warm start: the backend emits once the window already exists. Attach on
  // mount so an "Open With" that lands mid-restore isn't dropped — the backend
  // also seeds the drain-once state, so the boot drain below is the safety net.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<string[]>("codev:open-file", (e) => {
        openLaunchFiles(e.payload);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openLaunchFiles]);

  // Cold start: files arrive as CLI args (Linux/Windows) or the macOS open-files
  // event, and get_launch_files drains them once. Wait for `booted` — the spaces
  // restore ends in replaceTabs(), which overwrites the whole tab list and would
  // discard a launch tab opened before it, making the file flash open and vanish.
  // Booting first also lands the tab in the restored active space, and lets
  // openFileTab dedupe against a session that already had the file open.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      openLaunchFiles(await consumeLaunchFiles());
    })();
  }, [booted, openLaunchFiles]);

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      rebasePaths(from, to);
    },
    [rebasePaths],
  );

  const explorerActiveFilePath =
    activeTab?.kind === "editor" ||
    activeTab?.kind === "markdown" ||
    activeTab?.kind === "html"
      ? activeTab.path
      : null;

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "search.focus": () => {
        searchInlineRef.current?.focus();
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      handleCloseTabOrPane,
      openNewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (
      id: number,
      h: EditorPaneHandle | null,
      owner: "editor" | "markdown" | "html",
    ) => {
      if (h) {
        editorRefs.current.set(id, h);
        editorHandleOwners.current.set(id, owner);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
        if (id === activeId) setActiveEditorHandle(h);
      } else if (editorHandleOwners.current.get(id) === owner) {
        editorRefs.current.delete(id);
        editorHandleOwners.current.delete(id);
        if (id === activeId) setActiveEditorHandle(null);
      }
    },
    [activeId],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => setLeafCwd(leafId, cwd),
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isSearchableDocumentTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    return null;
  }, [
    isTerminalTab,
    isSearchableDocumentTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
  ]);

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchTarget,
            explorerRoot,
            home,
            openNewTab,
            openNewEditor: () => setNewEditorOpen(true),
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            openSettings: () => void openSettingsWindow(),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
    ],
  );

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = handleOpenFile(path, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [handleOpenFile],
  );

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              onToggleSidebar={toggleSidebar}
              onOpenSettings={() => void openSettingsWindow()}
              terminalPanelCollapsed={terminalPanelCollapsed}
              onToggleTerminalPanel={() => {
                if (terminalTabs.length === 0) openNewTab();
                else if (terminalPanelCollapsed) expandTerminalPanel();
                else terminalPanelRef.current?.collapse();
              }}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(
                _: Layout,
                { isUserInteraction }: LayoutChangedMeta,
              ) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
                const terminalWidth =
                  terminalPanelRef.current?.getSize().inPixels ?? 0;
                persistTerminalWidth(terminalWidth, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div className="min-h-0 flex-1 codev-panel-in">
                    <FileExplorer
                      ref={explorerRef}
                      roots={workspaceRoots}
                      activeRoot={activeRoot}
                      onAddRoot={(p) => void addRoot(p)}
                      onRemoveRoot={(p) => void removeRoot(p)}
                      onRenameRoot={renameWorkspaceRoot}
                      onSetActiveRoot={(p) => void setActiveRoot(p)}
                      activeFilePath={explorerActiveFilePath}
                      onOpenFile={handleOpenFile}
                      onOpenFileToSide={handleOpenFileToSide}
                      onPathRenamed={handlePathRenamed}
                      onPathDeleted={handlePathDeleted}
                      onRevealInTerminal={cdInNewTab}
                      pathDropTarget={terminalPathDropTarget}
                    />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="main-content" minSize="60px">
                <div className="relative h-full min-h-0">
                  <WorkspaceSurface
                    primaryTabs={primaryEditorTabs}
                    primaryActiveId={primaryActiveId}
                    secondaryTabs={secondaryEditorTabs}
                    secondaryActiveId={secondaryActiveId}
                    workspaceRoots={workspaceRoots}
                    onSelectPrimary={selectPrimaryEditor}
                    onSelectSecondary={selectSecondaryEditor}
                    onClose={handleClose}
                    onCloseTabsToRight={handleCloseTabsToRightInGroup}
                    onCloseOtherTabs={handleCloseOtherTabsInGroup}
                    onPin={pinTab}
                    onRename={handleRenameTab}
                    onReorderPrimary={reorderPrimaryEditors}
                    onReorderSecondary={reorderSecondaryEditors}
                    onOverrideLanguage={setOverrideLanguage}
                    onMoveToGroup={moveEditorToGroup}
                    registerEditorHandle={registerEditorHandle}
                    onEditorDirtyChange={handleEditorDirty}
                    onSetMarkdownView={setMarkdownView}
                    onSetHtmlView={setHtmlView}
                    onFocusEditor={focusEditor}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="terminal-panel"
                panelRef={terminalPanelRef}
                defaultSize={
                  initialTerminalCollapsed || terminalTabs.length === 0
                    ? "0px"
                    : `${terminalWidthRef.current}px`
                }
                minSize={`${TERMINAL_MIN_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistTerminalCollapsed(size.inPixels <= 1);
                }}
              >
                <TerminalPanel
                  tabs={terminalTabs}
                  activeId={terminalActiveId}
                  onSelect={setActiveId}
                  onClose={handleClose}
                  onNew={openNewTab}
                  onRename={handleRenameTab}
                  onReorder={reorderTerminals}
                  registerHandle={registerTerminalHandle}
                  onSearchReady={handleSearchReady}
                  onCwd={handleTerminalCwd}
                  onExit={handleLeafExit}
                  onFocusLeaf={handleFocusLeaf}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          <Toaster position="bottom-right" />

          {switcherState && (
            <TabSwitcherHud tabs={tabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoots={workspaceRoots}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => handleOpenFile(path)}
          />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingCloseMany={pendingCloseMany}
            closeManyConfirming={closeManyConfirming}
            onCancelCloseMany={cancelCloseMany}
            onConfirmCloseMany={confirmCloseMany}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return shell;
}
