import { useCallback } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  normalizeWorkspaceRoot,
  normalizeWorkspaceRoots,
  setActiveWorkspaceRoot,
  setWorkspaceRoots,
} from "@/modules/settings/store";
import { workspaceAuthorize } from "@/modules/workspace/native";

/**
 * Multi-root workspace state. Roots are imported folders (forward-slash
 * paths, e.g. `C:/Users/me/proj` or drive roots like `C:/`); the active root
 * decides where new tabs/files land. Persisted globally via preferences.
 */
export function useWorkspaceRoots() {
  const roots = usePreferencesStore((s) => s.workspaceRoots);
  const activeRoot = usePreferencesStore((s) => s.activeWorkspaceRoot);

  const addRoot = useCallback(async (path: string) => {
    const norm = normalizeWorkspaceRoot(path);
    if (!norm) return;
    const current = usePreferencesStore.getState().workspaceRoots;
    const existing = current.find(
      (root) => root.toLowerCase() === norm.toLowerCase(),
    );
    if (existing) {
      // Already imported: just focus it.
      await setActiveWorkspaceRoot(existing);
      return;
    }
    const next = normalizeWorkspaceRoots([...current, norm]);
    await setWorkspaceRoots(next);
    await setActiveWorkspaceRoot(norm);
  }, []);

  const removeRoot = useCallback(async (path: string) => {
    const current = usePreferencesStore.getState().workspaceRoots;
    const next = current.filter((r) => r !== path);
    await setWorkspaceRoots(next);
    const active = usePreferencesStore.getState().activeWorkspaceRoot;
    if (active === path) {
      await setActiveWorkspaceRoot(next[0] ?? null);
    }
  }, []);

  const setActiveRoot = useCallback(async (path: string | null) => {
    await setActiveWorkspaceRoot(path);
  }, []);

  /** 将已完成磁盘改名的根目录同步到工作区持久化状态。 */
  const renameRoot = useCallback(async (from: string, to: string) => {
    try {
      await workspaceAuthorize(to);
    } catch (error) {
      console.error("workspace authorization after rename failed:", error);
    }
    const current = usePreferencesStore.getState().workspaceRoots;
    const next = current.map((root) => (root === from ? to : root));
    await setWorkspaceRoots(next);
    if (usePreferencesStore.getState().activeWorkspaceRoot === from) {
      await setActiveWorkspaceRoot(to);
    }
  }, []);

  return { roots, activeRoot, addRoot, removeRoot, renameRoot, setActiveRoot };
}
