import { create } from "zustand";
import { agentClient } from "@/modules/agent/client";
import { onHostEvent } from "@/modules/agent/hostEvents";
import type { SessionView, Workspace } from "@/modules/agent/types";
import {
  normalizeVcsPath,
  type VcsBranch,
  type VcsCommit,
  type VcsCommitDetail,
  type VcsConflictVersions,
  type VcsDiffPayload,
  type VcsDoctorReport,
  type VcsEntry,
  type VcsSnapshot,
  type VcsStashEntry,
  type VcsWorktree,
} from "./types";

export type VcsBadgeTone =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "conflict";

export type FileVcsIndicator = {
  code: "M" | "A" | "D" | "U" | "!";
  tone: VcsBadgeTone;
  staged: boolean;
  entry?: VcsEntry;
};

export type RepoBadgeIndex = {
  root: string;
  files: Map<string, FileVcsIndicator>;
  dirs: Map<string, VcsBadgeTone>;
};

type VcsStoreState = {
  snapshots: Record<string, VcsSnapshot>;
  nonRepoRoots: Record<string, boolean>;
  branches: Record<string, VcsBranch[]>;
  commits: Record<string, VcsCommit[]>;
  worktrees: Record<string, VcsWorktree[]>;
  stashes: Record<string, VcsStashEntry[]>;
  doctor: VcsDoctorReport | null;

  applyVcsSnapshots: (vcsSnapshots?: VcsSnapshot[]) => void;
  applyVcsSnapshot: (snapshot: VcsSnapshot) => void;

  refreshSnapshot: (root: string) => Promise<VcsSnapshot | null>;
  loadBranches: (root: string) => Promise<VcsBranch[]>;
  loadLog: (
    root: string,
    opts?: { all?: boolean; limit?: number; search?: string },
  ) => Promise<VcsCommit[]>;
  loadCommitDetail: (root: string, hash: string) => Promise<VcsCommitDetail>;
  loadCommitFileDiff: (
    root: string,
    hash: string,
    path: string,
  ) => Promise<VcsDiffPayload>;
  loadStashes: (root: string) => Promise<VcsStashEntry[]>;
  loadWorktrees: (root: string) => Promise<VcsWorktree[]>;
  loadDiff: (
    root: string,
    path: string,
    staged?: boolean,
  ) => Promise<VcsDiffPayload>;
  loadConflictVersions: (
    root: string,
    path: string,
  ) => Promise<VcsConflictVersions>;

  initRepo: (root: string, defaultBranch?: string) => Promise<VcsSnapshot>;
  stage: (root: string, paths: string[], staged: boolean) => Promise<void>;
  stageAll: (root: string, staged: boolean) => Promise<void>;
  applyHunk: (
    root: string,
    patch: string,
    cached: boolean,
    reverse: boolean,
  ) => Promise<void>;
  discard: (root: string, paths: string[]) => Promise<void>;
  commit: (
    root: string,
    message: string,
    opts?: { amend?: boolean; push?: boolean; setUpstream?: boolean },
  ) => Promise<void>;
  aiCommit: (root: string) => Promise<string>;
  checkout: (root: string, target: string) => Promise<void>;
  createBranch: (
    root: string,
    name: string,
    startPoint?: string,
    checkout?: boolean,
  ) => Promise<void>;
  deleteBranch: (
    root: string,
    name: string,
    force?: boolean,
    deleteRemote?: boolean,
  ) => Promise<void>;
  merge: (root: string, source: string) => Promise<void>;
  rebase: (root: string, upstream: string) => Promise<void>;
  cherryPick: (root: string, hash: string) => Promise<void>;
  revertCommit: (root: string, hash: string) => Promise<void>;
  continueOp: (root: string) => Promise<void>;
  abortOp: (root: string) => Promise<void>;
  resolveConflict: (
    root: string,
    path: string,
    strategy: "ours" | "theirs" | "custom",
    content?: string,
  ) => Promise<void>;
  stashPush: (
    root: string,
    message?: string,
    includeUntracked?: boolean,
  ) => Promise<void>;
  stashApply: (root: string, index: number, pop?: boolean) => Promise<void>;
  stashDrop: (root: string, index: number) => Promise<void>;
  worktreeAdd: (
    root: string,
    branch: string,
    opts?: { createBranch?: boolean; startPoint?: string; reason?: string },
  ) => Promise<{ worktree: VcsWorktree; workspace: Workspace }>;
  worktreeRemove: (
    root: string,
    path: string,
    force?: boolean,
  ) => Promise<void>;
  spawnWorktreeSession: (
    root: string,
    opts: {
      branch: string;
      createBranch?: boolean;
      startPoint?: string;
      harnessId?: string;
      title?: string;
    },
  ) => Promise<{
    worktree: VcsWorktree;
    workspace: Workspace;
    session: SessionView;
  }>;
  fetch: (root: string, prune?: boolean) => Promise<void>;
  pull: (root: string, rebase?: boolean) => Promise<void>;
  push: (root: string, setUpstream?: boolean) => Promise<void>;
  checkDoctor: (root?: string) => Promise<VcsDoctorReport>;
  fixDoctor: (opts: {
    userName?: string;
    userEmail?: string;
    applyRecommended?: boolean;
  }) => Promise<void>;
  revertTurnChanges: (sessionId: string) => Promise<void>;
};

export function entryIndicator(entry: VcsEntry): FileVcsIndicator {
  if (entry.conflicted) {
    return { code: "!", tone: "conflict", staged: false, entry };
  }
  if (entry.untracked || entry.indexStatus === "A") {
    return {
      code: entry.untracked ? "U" : "A",
      tone: entry.untracked ? "untracked" : "added",
      staged: entry.staged,
      entry,
    };
  }
  if (entry.indexStatus === "D" || entry.worktreeStatus === "D") {
    return { code: "D", tone: "deleted", staged: entry.staged, entry };
  }
  return { code: "M", tone: "modified", staged: entry.staged, entry };
}

export function buildRepoBadgeIndex(
  snapshot: VcsSnapshot | null | undefined,
): RepoBadgeIndex | null {
  if (!snapshot) return null;
  const root = normalizeVcsPath(snapshot.worktreeRoot);
  const files = new Map<string, FileVcsIndicator>();
  const dirs = new Map<string, VcsBadgeTone>();
  for (const entry of snapshot.entries) {
    const ind = entryIndicator(entry);
    const full = `${root}/${entry.path}`;
    files.set(full, ind);
    const parts = entry.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cur = `${cur}/${parts[i]}`;
      const existing = dirs.get(cur);
      if (ind.tone === "conflict" || !existing) {
        dirs.set(cur, ind.tone);
      }
    }
  }
  return { root, files, dirs };
}

export function findSnapshotForPath(
  snapshots: Record<string, VcsSnapshot>,
  path: string | null | undefined,
): VcsSnapshot | null {
  if (!path) return null;
  const target = normalizeVcsPath(path);
  let best: VcsSnapshot | null = null;
  let bestLen = -1;
  for (const snap of Object.values(snapshots)) {
    const root = normalizeVcsPath(snap.worktreeRoot);
    if (target === root || target.startsWith(`${root}/`)) {
      if (root.length > bestLen) {
        best = snap;
        bestLen = root.length;
      }
    }
  }
  return best;
}

const inflightSnapshots = new Map<string, Promise<VcsSnapshot | null>>();

export const useVcsStore = create<VcsStoreState>((set, get) => ({
  snapshots: {},
  nonRepoRoots: {},
  branches: {},
  commits: {},
  worktrees: {},
  stashes: {},
  doctor: null,

  applyVcsSnapshots: (vcsSnapshots) => {
    if (!vcsSnapshots?.length) return;
    set((state) => {
      const nextSnaps = { ...state.snapshots };
      for (const snap of vcsSnapshots) {
        nextSnaps[normalizeVcsPath(snap.worktreeRoot)] = snap;
      }
      return { snapshots: nextSnaps };
    });
  },

  applyVcsSnapshot: (snapshot) =>
    set((state) => {
      const key = normalizeVcsPath(snapshot.worktreeRoot);
      const nextNonRepo = { ...state.nonRepoRoots };
      delete nextNonRepo[key];
      return {
        snapshots: { ...state.snapshots, [key]: snapshot },
        nonRepoRoots: nextNonRepo,
      };
    }),

  refreshSnapshot: (root) => {
    const key = normalizeVcsPath(root);
    const existing = inflightSnapshots.get(key);
    if (existing) return existing;
    const promise = agentClient
      .request<{ snapshot: VcsSnapshot | null }>("vcs.snapshot", { root })
      .then((res) => {
        if (res.snapshot) {
          get().applyVcsSnapshot(res.snapshot);
        } else {
          set((s) => ({ nonRepoRoots: { ...s.nonRepoRoots, [key]: true } }));
        }
        return res.snapshot;
      })
      .finally(() => {
        inflightSnapshots.delete(key);
      });
    inflightSnapshots.set(key, promise);
    return promise;
  },

  loadBranches: async (root) => {
    const res = await agentClient.request<{ branches: VcsBranch[] }>(
      "vcs.branches",
      { root },
    );
    const key = normalizeVcsPath(root);
    set((s) => ({ branches: { ...s.branches, [key]: res.branches } }));
    return res.branches;
  },

  loadLog: async (root, opts) => {
    const res = await agentClient.request<{ commits: VcsCommit[] }>("vcs.log", {
      root,
      all: opts?.all ?? false,
      limit: opts?.limit ?? 100,
      search: opts?.search,
    });
    const key = normalizeVcsPath(root);
    set((s) => ({ commits: { ...s.commits, [key]: res.commits } }));
    return res.commits;
  },

  loadCommitDetail: (root, hash) =>
    agentClient.request<VcsCommitDetail>("vcs.commit.detail", { root, hash }),

  loadCommitFileDiff: (root, hash, path) =>
    agentClient.request<VcsDiffPayload>("vcs.commit.diff", {
      root,
      hash,
      path,
    }),

  loadStashes: async (root) => {
    const res = await agentClient.request<{ stashes: VcsStashEntry[] }>(
      "vcs.stash.list",
      { root },
    );
    const key = normalizeVcsPath(root);
    set((s) => ({ stashes: { ...s.stashes, [key]: res.stashes } }));
    return res.stashes;
  },

  loadWorktrees: async (root) => {
    const res = await agentClient.request<{ worktrees: VcsWorktree[] }>(
      "vcs.worktree.list",
      { root },
    );
    const key = normalizeVcsPath(root);
    set((s) => ({ worktrees: { ...s.worktrees, [key]: res.worktrees } }));
    return res.worktrees;
  },

  loadDiff: (root, path, staged = false) =>
    agentClient.request<VcsDiffPayload>("vcs.diff", { root, path, staged }),

  loadConflictVersions: (root, path) =>
    agentClient.request<VcsConflictVersions>("vcs.conflict.versions", {
      root,
      path,
    }),

  initRepo: async (root, defaultBranch) => {
    const res = await agentClient.request<{ snapshot: VcsSnapshot }>(
      "vcs.init",
      { root, defaultBranch },
    );
    get().applyVcsSnapshot(res.snapshot);
    return res.snapshot;
  },

  stage: async (root, paths, staged) => {
    await agentClient.request("vcs.stage", { root, paths, staged });
  },

  stageAll: async (root, staged) => {
    await agentClient.request("vcs.stage_all", { root, staged });
  },

  applyHunk: async (root, patch, cached, reverse) => {
    await agentClient.request("vcs.hunk", { root, patch, cached, reverse });
  },

  discard: async (root, paths) => {
    await agentClient.request("vcs.discard", { root, paths });
  },

  commit: async (root, message, opts) => {
    await agentClient.request("vcs.commit", {
      root,
      message,
      amend: opts?.amend ?? false,
      push: opts?.push ?? false,
      setUpstream: opts?.setUpstream ?? false,
    });
  },

  aiCommit: async (root) => {
    const res = await agentClient.request<{ message: string }>(
      "vcs.ai_commit",
      { root },
    );
    return res.message;
  },

  checkout: async (root, target) => {
    await agentClient.request("vcs.checkout", { root, target });
    void get().loadBranches(root);
  },

  createBranch: async (root, name, startPoint, checkout = true) => {
    await agentClient.request("vcs.branch.create", {
      root,
      name,
      startPoint,
      checkout,
    });
    void get().loadBranches(root);
  },

  deleteBranch: async (root, name, force = false, deleteRemote = false) => {
    await agentClient.request("vcs.branch.delete", {
      root,
      name,
      force,
      deleteRemote,
    });
    void get().loadBranches(root);
  },

  merge: async (root, source) => {
    await agentClient.request("vcs.merge", { root, source });
    void get().loadBranches(root);
  },

  rebase: async (root, upstream) => {
    await agentClient.request("vcs.rebase", { root, upstream });
    void get().loadBranches(root);
  },

  cherryPick: async (root, hash) => {
    await agentClient.request("vcs.cherry_pick", { root, hash });
  },

  revertCommit: async (root, hash) => {
    await agentClient.request("vcs.revert", { root, hash });
  },

  continueOp: async (root) => {
    await agentClient.request("vcs.op.continue", { root });
  },

  abortOp: async (root) => {
    await agentClient.request("vcs.op.abort", { root });
  },

  resolveConflict: async (root, path, strategy, content) => {
    await agentClient.request("vcs.conflict.resolve", {
      root,
      path,
      strategy,
      content,
    });
  },

  stashPush: async (root, message, includeUntracked = true) => {
    await agentClient.request("vcs.stash.push", {
      root,
      message,
      includeUntracked,
    });
    void get().loadStashes(root);
  },

  stashApply: async (root, index, pop = false) => {
    await agentClient.request("vcs.stash.apply", { root, index, pop });
    void get().loadStashes(root);
  },

  stashDrop: async (root, index) => {
    await agentClient.request("vcs.stash.drop", { root, index });
    void get().loadStashes(root);
  },

  worktreeAdd: async (root, branch, opts) => {
    const res = await agentClient.request<{
      worktree: VcsWorktree;
      workspace: Workspace;
    }>("vcs.worktree.add", {
      root,
      branch,
      createBranch: opts?.createBranch ?? true,
      startPoint: opts?.startPoint,
      reason: opts?.reason,
    });
    void get().loadWorktrees(root);
    return res;
  },

  worktreeRemove: async (root, path, force = false) => {
    await agentClient.request("vcs.worktree.remove", { root, path, force });
    void get().loadWorktrees(root);
  },

  spawnWorktreeSession: async (root, opts) => {
    const res = await agentClient.request<{
      worktree: VcsWorktree;
      workspace: Workspace;
      session: SessionView;
    }>("vcs.worktree.session", opts ? { root, ...opts } : { root });
    void get().loadWorktrees(root);
    return res;
  },

  fetch: async (root, prune = true) => {
    await agentClient.request("vcs.fetch", { root, prune });
  },

  pull: async (root, rebase) => {
    await agentClient.request("vcs.pull", { root, rebase });
  },

  push: async (root, setUpstream = false) => {
    await agentClient.request("vcs.push", { root, setUpstream });
  },

  checkDoctor: async (root) => {
    const report = await agentClient.request<VcsDoctorReport>(
      "vcs.doctor.check",
      { root },
    );
    set({ doctor: report });
    return report;
  },

  fixDoctor: async (opts) => {
    await agentClient.request("vcs.doctor.fix", opts);
  },

  revertTurnChanges: async (sessionId) => {
    await agentClient.request("vcs.turn.revert", {}, sessionId);
  },
}));

// Register event bus subscriptions for host-pushed VCS snapshots/updates.
onHostEvent("host.snapshot", ({ vcsSnapshots }) => {
  useVcsStore.getState().applyVcsSnapshots(vcsSnapshots);
});
onHostEvent("vcs.changed", ({ snapshot }) => {
  useVcsStore.getState().applyVcsSnapshot(snapshot);
});
