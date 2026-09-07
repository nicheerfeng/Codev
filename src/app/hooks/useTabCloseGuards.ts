import {
  type CloseManyHazards,
  type CloseManyKind,
  type CloseManyPending,
  evaluateCloseHazards,
  hasCloseManyHazards,
  hasNewCloseManyHazards,
} from "@/app/hooks/tabCloseGuards";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type CloseTabsPlan,
  nextActiveInSpace,
  planCloseOtherTabs,
  planCloseTabsToRight,
  type Tab,
} from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

function confirmRunningTerminal(): boolean {
  return usePreferencesStore.getState().confirmCloseRunningTerminal;
}

/** 判断标签是否为当前关闭范围内的可保存未保存文件。 */
function isDirtyFileTab(tab: Tab): boolean {
  return (
    (tab.kind === "editor" ||
      (tab.kind === "markdown" && tab.viewMode === "raw") ||
      (tab.kind === "html" && tab.viewMode === "raw")) &&
    tab.dirty
  );
}

type Params = {
  tabs: Tab[];
  activeId: number;
  disposeTab: (id: number) => void;
  disposeTabs: (anchorId: number, plan: CloseTabsPlan) => void;
  saveTab: (id: number) => Promise<boolean>;
};

/**
 * Guards tab closing: live terminal processes route through confirmation,
 * while dirty file buffers are saved before the tabs are disposed.
 */
export function useTabCloseGuards({
  tabs,
  activeId,
  disposeTab,
  disposeTabs,
  saveTab,
}: Params) {
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  const [pendingCloseMany, setPendingCloseMany] =
    useState<CloseManyPending | null>(null);
  const [closeManyConfirming, setCloseManyConfirming] = useState(false);
  const closeManyRequestRef = useRef(0);

  /** 关闭前顺序保存目标文件，任一失败时保留全部目标标签。 */
  const saveDirtyTabs = useCallback(
    async (ids: number[]): Promise<boolean> => {
      const targets = new Set(ids);
      const dirtyTabs = tabsRef.current.filter(
        (tab) => targets.has(tab.id) && isDirtyFileTab(tab),
      );
      for (const tab of dirtyTabs) {
        try {
          if (await saveTab(tab.id)) continue;
          toast.error(`保存失败，已取消关闭：${tab.title}`);
          return false;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          toast.error(`保存失败，已取消关闭：${tab.title}`, {
            description: reason,
          });
          return false;
        }
      }
      return true;
    },
    [saveTab],
  );

  const handleClose = useCallback(
    async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      // A file-only workspace may close its final editor; the final terminal
      // remains protected because it is the shell session for that space.
      if (
        nextActiveInSpace(tabs, id) === null &&
        t?.kind !== "editor" &&
        t?.kind !== "markdown" &&
        t?.kind !== "html"
      )
        return;
      if (t?.kind === "terminal" && confirmRunningTerminal()) {
        const leaves = leafIds(t.paneTree);
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        if (checks.some(Boolean)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      if (!(await saveDirtyTabs([id]))) return;
      disposeTab(id);
    },
    [tabs, disposeTab, saveDirtyTabs],
  );

  const captureCloseMany = useCallback((closeIds: number[]) => {
    const close = new Set(closeIds);
    const affected = tabsRef.current.filter((tab) => close.has(tab.id));
    return {
      leafIds: affected
        .filter((tab) => tab.kind === "terminal")
        .flatMap((tab) => leafIds(tab.paneTree)),
    };
  }, []);

  const evaluateCloseMany = useCallback(
    (closeIds: number[]): Promise<CloseManyHazards> =>
      evaluateCloseHazards(
        () => captureCloseMany(closeIds),
        leafHasForegroundProcess,
        confirmRunningTerminal(),
      ),
    [captureCloseMany],
  );

  const planCloseMany = useCallback(
    (kind: CloseManyKind, anchorId: number, scopeIds?: number[]) => {
      const source = scopeIds
        ? tabsRef.current.filter((tab) => scopeIds.includes(tab.id))
        : tabsRef.current;
      return kind === "right"
        ? planCloseTabsToRight(source, anchorId, activeIdRef.current)
        : planCloseOtherTabs(source, anchorId, activeIdRef.current);
    },
    [],
  );

  const withCurrentActive = useCallback(
    (plan: CloseTabsPlan): CloseTabsPlan => ({
      closeIds: plan.closeIds,
      nextActiveId: activeIdRef.current,
    }),
    [],
  );

  const handleCloseMany = useCallback(
    async (kind: CloseManyKind, anchorId: number, scopeIds?: number[]) => {
      const plan = planCloseMany(kind, anchorId, scopeIds);
      if (plan.closeIds.length === 0) return;
      const requestId = ++closeManyRequestRef.current;
      const hazards = await evaluateCloseMany(plan.closeIds);
      if (requestId !== closeManyRequestRef.current) return;
      if (hasCloseManyHazards(hazards)) {
        setPendingCloseMany({ kind, anchorId, plan, ...hazards });
        return;
      }
      if (!(await saveDirtyTabs(plan.closeIds))) return;
      if (requestId !== closeManyRequestRef.current) return;
      disposeTabs(anchorId, withCurrentActive(plan));
    },
    [
      disposeTabs,
      evaluateCloseMany,
      planCloseMany,
      saveDirtyTabs,
      withCurrentActive,
    ],
  );

  const handleCloseTabsToRight = useCallback(
    (anchorId: number) => {
      void handleCloseMany("right", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseOtherTabs = useCallback(
    (anchorId: number) => {
      void handleCloseMany("other", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseTabsToRightInGroup = useCallback(
    (groupIds: number[], anchorId: number) => {
      void handleCloseMany("right", anchorId, groupIds);
    },
    [handleCloseMany],
  );

  const handleCloseOtherTabsInGroup = useCallback(
    (groupIds: number[], anchorId: number) => {
      void handleCloseMany("other", anchorId, groupIds);
    },
    [handleCloseMany],
  );

  const confirmCloseMany = useCallback(async () => {
    if (pendingCloseMany === null) return;
    const requestId = ++closeManyRequestRef.current;
    setCloseManyConfirming(true);
    const hazards = await evaluateCloseMany(pendingCloseMany.plan.closeIds);
    if (requestId !== closeManyRequestRef.current) return;
    if (hasNewCloseManyHazards(pendingCloseMany, hazards)) {
      setPendingCloseMany({ ...pendingCloseMany, ...hazards });
      setCloseManyConfirming(false);
      return;
    }
    const saved = await saveDirtyTabs(pendingCloseMany.plan.closeIds);
    if (requestId !== closeManyRequestRef.current) return;
    if (!saved) {
      setPendingCloseMany(null);
      setCloseManyConfirming(false);
      return;
    }
    disposeTabs(
      pendingCloseMany.anchorId,
      withCurrentActive(pendingCloseMany.plan),
    );
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, [
    pendingCloseMany,
    disposeTabs,
    evaluateCloseMany,
    saveDirtyTabs,
    withCurrentActive,
  ]);

  const cancelCloseMany = useCallback(() => {
    closeManyRequestRef.current += 1;
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, []);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null) disposeTab(pendingTerminalCloseTab);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTab]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind === "terminal") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  return {
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    handleCloseTabsToRightInGroup,
    handleCloseOtherTabsInGroup,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathDeleted,
  };
}
