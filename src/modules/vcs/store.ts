import { create } from "zustand";
import { uiState } from "@/lib/uiState";
import { agentClient } from "@/modules/agent/client";
import type { SessionView, Workspace } from "@/modules/agent/types";
import {
  normalizeVcsPath,
  type ForgeAuthStatus,
  type ForgeCheckRun,
  type ForgeComment,
  type ForgeInboxSnapshot,
  type ForgeIssue,
  type ForgePrFile,
  type ForgeRepoOption,
  type ForgeTarget,
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

export type VcsBadgeTone = "modified" | "added" | "deleted" | "untracked" | "conflict";

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
  inboxes: Record<string, ForgeInboxSnapshot>;
  forgeRepos: ForgeRepoOption[];
  forgeAuth: ForgeAuthStatus | null;
  forgeComments: Record<string, ForgeComment[]>;
  doctor: VcsDoctorReport | null;
  activeInboxRepo: string | null;
  totalForgeUnread: number;

  setActiveInboxRepo: (repoFullName: string | null) => void;
  hydrateForgeCache: () => void;

  applyHostSnapshots: (
    vcsSnapshots?: VcsSnapshot[],
    forgeInboxes?: ForgeInboxSnapshot[],
  ) => void;
  applyVcsSnapshot: (snapshot: VcsSnapshot) => void;
  applyForgeInbox: (inbox: ForgeInboxSnapshot) => void;

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
  worktreeRemove: (root: string, path: string, force?: boolean) => Promise<void>;
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

  loadForgeRepos: (
    roots?: string[],
  ) => Promise<{ repos: ForgeRepoOption[]; auth: ForgeAuthStatus }>;
  fetchInbox: (
    target: ForgeTarget,
    state?: string,
  ) => Promise<ForgeInboxSnapshot>;
  syncForge: (
    target: ForgeTarget,
    state?: string,
  ) => Promise<ForgeInboxSnapshot>;
  fetchComments: (
    target: ForgeTarget,
    number: number,
  ) => Promise<ForgeComment[]>;
  fetchForgeImage: (url: string) => Promise<string>;
  fetchPrChecks: (
    target: ForgeTarget,
    sha: string,
  ) => Promise<ForgeCheckRun[]>;
  fetchPrFiles: (
    target: ForgeTarget,
    number: number,
  ) => Promise<ForgePrFile[]>;
  createComment: (
    target: ForgeTarget,
    number: number,
    body: string,
  ) => Promise<ForgeComment>;
  createIssue: (
    target: ForgeTarget,
    title: string,
    body: string,
  ) => Promise<ForgeIssue>;
  setIssueState: (
    target: ForgeTarget,
    number: number,
    state: "open" | "closed",
  ) => Promise<void>;
  mergePr: (
    target: ForgeTarget,
    number: number,
    method?: "merge" | "squash" | "rebase",
  ) => Promise<void>;
  markNotificationRead: (target: ForgeTarget, id: string) => Promise<void>;
  setForgePat: (token: string) => Promise<ForgeInboxSnapshot["auth"]>;
  dispatchIssueToAgent: (
    root: string,
    opts: {
      kind: "issue" | "pr";
      number: number;
      title: string;
      body?: string;
      htmlUrl?: string;
      harnessId?: string;
      baseBranch?: string;
    },
  ) => Promise<{
    worktree: VcsWorktree;
    workspace: Workspace;
    session: SessionView;
    initialPrompt: string;
  }>;
};

function computeTotalUnread(inboxes: Record<string, ForgeInboxSnapshot>): number {
  return Object.values(inboxes).reduce(
    (sum, inbox) => sum + (inbox.unreadCount ?? 0),
    0,
  );
}

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

export function buildRepoBadgeIndex(snapshot: VcsSnapshot | null | undefined): RepoBadgeIndex | null {
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

function toForgeTargetPayload(target: ForgeTarget): {
  root?: string;
  repoFullName?: string;
  host?: string;
} {
  return typeof target === "string" ? { root: target } : target;
}

const FORGE_ACTIVE_REPO_KEY = "codev.forge.activeRepo";
const FORGE_REPOS_CACHE_KEY = "codev.forge.repos";
const FORGE_INBOXES_CACHE_KEY = "codev.forge.inboxes";
const MAX_CACHED_INBOX_REPOS = 6;
const MAX_CACHED_REPO_OPTIONS = 120;

const inflightSnapshots = new Map<string, Promise<VcsSnapshot | null>>();
const inflightForgeImages = new Map<string, Promise<string>>();
const resolvedForgeImages = new Map<string, string>();

function readUiJson<T>(key: string): T | null {
  try {
    const raw = uiState.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeUiJson(key: string, value: unknown): void {
  try {
    uiState.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略序列化或测试环境存储异常
  }
}

function trimInboxesForCache(
  inboxes: Record<string, ForgeInboxSnapshot>,
): Record<string, ForgeInboxSnapshot> {
  const sorted = Object.entries(inboxes)
    .filter(([, inbox]) => Boolean(inbox?.repo?.fullName) && !inbox.error)
    .sort(([, a], [, b]) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0))
    .slice(0, MAX_CACHED_INBOX_REPOS);
  const out: Record<string, ForgeInboxSnapshot> = {};
  for (const [key, inbox] of sorted) {
    out[key] = {
      ...inbox,
      notifications: inbox.notifications.slice(0, 30),
      issues: inbox.issues.slice(0, 40),
      pulls: inbox.pulls.slice(0, 25),
    };
  }
  return out;
}

export function forgeCommentsCacheKey(target: ForgeTarget, number: number): string {
  const payload = toForgeTargetPayload(target);
  const scope = payload.repoFullName?.toLowerCase() || normalizeVcsPath(payload.root ?? "") || "default";
  return `${scope}#${number}`;
}

function readInitialForgeCache() {
  const activeInboxRepo = uiState.getItem(FORGE_ACTIVE_REPO_KEY) || null;
  const cachedRepos = readUiJson<{ repos?: ForgeRepoOption[]; auth?: ForgeAuthStatus | null }>(
    FORGE_REPOS_CACHE_KEY,
  );
  const cachedInboxes = readUiJson<Record<string, ForgeInboxSnapshot>>(FORGE_INBOXES_CACHE_KEY);
  const inboxes = cachedInboxes && typeof cachedInboxes === "object" ? cachedInboxes : {};
  return {
    activeInboxRepo,
    forgeRepos: Array.isArray(cachedRepos?.repos) ? cachedRepos.repos : [],
    forgeAuth: cachedRepos?.auth ?? null,
    inboxes,
    totalForgeUnread: computeTotalUnread(inboxes),
  };
}

const initialForgeCache = readInitialForgeCache();

export const useVcsStore = create<VcsStoreState>((set, get) => ({
  snapshots: {},
  nonRepoRoots: {},
  branches: {},
  commits: {},
  worktrees: {},
  stashes: {},
  inboxes: initialForgeCache.inboxes,
  forgeRepos: initialForgeCache.forgeRepos,
  forgeAuth: initialForgeCache.forgeAuth,
  forgeComments: {},
  doctor: null,
  activeInboxRepo: initialForgeCache.activeInboxRepo,
  totalForgeUnread: initialForgeCache.totalForgeUnread,

  setActiveInboxRepo: (repoFullName) => {
    uiState.setItem(FORGE_ACTIVE_REPO_KEY, repoFullName ?? "");
    set({ activeInboxRepo: repoFullName });
  },

  hydrateForgeCache: () => {
    const cached = readInitialForgeCache();
    set((state) => {
      const mergedInboxes = { ...cached.inboxes, ...state.inboxes };
      return {
        activeInboxRepo: state.activeInboxRepo ?? cached.activeInboxRepo,
        forgeRepos: state.forgeRepos.length > 0 ? state.forgeRepos : cached.forgeRepos,
        forgeAuth: state.forgeAuth ?? cached.forgeAuth,
        inboxes: mergedInboxes,
        totalForgeUnread: computeTotalUnread(mergedInboxes),
      };
    });
  },

  applyHostSnapshots: (vcsSnapshots, forgeInboxes) =>
    set((state) => {
      const nextSnaps = { ...state.snapshots };
      for (const snap of vcsSnapshots ?? []) {
        nextSnaps[normalizeVcsPath(snap.worktreeRoot)] = snap;
      }
      const nextInboxes = { ...state.inboxes };
      for (const inbox of forgeInboxes ?? []) {
        if (inbox.repo?.fullName) {
          nextInboxes[inbox.repo.fullName] = inbox;
        }
      }
      writeUiJson(FORGE_INBOXES_CACHE_KEY, trimInboxesForCache(nextInboxes));
      return {
        snapshots: nextSnaps,
        inboxes: nextInboxes,
        totalForgeUnread: computeTotalUnread(nextInboxes),
      };
    }),

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

  applyForgeInbox: (inbox) =>
    set((state) => {
      const key = inbox.repo?.fullName;
      if (!key) return {};
      const next = { ...state.inboxes, [key]: inbox };
      const nextActive = state.activeInboxRepo ?? key;
      if (!state.activeInboxRepo) {
        uiState.setItem(FORGE_ACTIVE_REPO_KEY, nextActive);
      }
      writeUiJson(FORGE_INBOXES_CACHE_KEY, trimInboxesForCache(next));
      return {
        inboxes: next,
        activeInboxRepo: nextActive,
        totalForgeUnread: computeTotalUnread(next),
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

  loadForgeRepos: async (roots = []) => {
    const res = await agentClient.request<{
      repos: ForgeRepoOption[];
      auth: ForgeAuthStatus;
    }>("forge.repos", { roots });
    const repos = res.repos ?? [];
    const auth = res.auth ?? null;
    set({ forgeRepos: repos, forgeAuth: auth });
    writeUiJson(FORGE_REPOS_CACHE_KEY, {
      repos: repos.slice(0, MAX_CACHED_REPO_OPTIONS),
      auth,
    });
    return res;
  },

  fetchInbox: async (target, state = "open") => {
    const inbox = await agentClient.request<ForgeInboxSnapshot>("forge.inbox", {
      ...toForgeTargetPayload(target),
      state,
    });
    if (inbox.auth) set({ forgeAuth: inbox.auth });
    get().applyForgeInbox(inbox);
    return inbox;
  },

  syncForge: async (target, state = "open") => {
    const inbox = await agentClient.request<ForgeInboxSnapshot>("forge.sync", {
      ...toForgeTargetPayload(target),
      state,
    });
    if (inbox.auth) set({ forgeAuth: inbox.auth });
    get().applyForgeInbox(inbox);
    return inbox;
  },

  fetchComments: async (target, number) => {
    const res = await agentClient.request<{ comments: ForgeComment[] }>(
      "forge.comments",
      { ...toForgeTargetPayload(target), number },
    );
    const cacheKey = forgeCommentsCacheKey(target, number);
    set((state) => ({
      forgeComments: { ...state.forgeComments, [cacheKey]: res.comments },
    }));
    return res.comments;
  },

  fetchForgeImage: (url) => {
    const cached = resolvedForgeImages.get(url);
    if (cached) return Promise.resolve(cached);
    const existing = inflightForgeImages.get(url);
    if (existing) return existing;
    const promise = agentClient
      .request<{ dataUrl: string }>("forge.image", { url })
      .then((res) => {
        resolvedForgeImages.set(url, res.dataUrl);
        return res.dataUrl;
      })
      .finally(() => {
        inflightForgeImages.delete(url);
      });
    inflightForgeImages.set(url, promise);
    return promise;
  },

  fetchPrChecks: async (target, sha) => {
    const res = await agentClient.request<{ checks: ForgeCheckRun[] }>(
      "forge.pr.checks",
      { ...toForgeTargetPayload(target), sha },
    );
    return res.checks;
  },

  fetchPrFiles: async (target, number) => {
    const res = await agentClient.request<{ files: ForgePrFile[] }>(
      "forge.pr.files",
      { ...toForgeTargetPayload(target), number },
    );
    return res.files;
  },

  createComment: async (target, number, body) => {
    const res = await agentClient.request<{ comment: ForgeComment }>(
      "forge.comment.create",
      { ...toForgeTargetPayload(target), number, body },
    );
    return res.comment;
  },

  createIssue: async (target, title, body) => {
    const res = await agentClient.request<{ issue: ForgeIssue }>(
      "forge.issue.create",
      { ...toForgeTargetPayload(target), title, body },
    );
    return res.issue;
  },

  setIssueState: async (target, number, state) => {
    await agentClient.request("forge.issue.state", {
      ...toForgeTargetPayload(target),
      number,
      state,
    });
  },

  mergePr: async (target, number, method = "squash") => {
    await agentClient.request("forge.pr.merge", {
      ...toForgeTargetPayload(target),
      number,
      method,
    });
  },

  markNotificationRead: async (target, id) => {
    await agentClient.request("forge.notification.read", {
      ...toForgeTargetPayload(target),
      id,
    });
  },

  setForgePat: (token) =>
    agentClient.request<ForgeInboxSnapshot["auth"]>("forge.pat.set", { token }),

  dispatchIssueToAgent: (root, opts) =>
    agentClient.request("forge.dispatch_agent", { root, ...opts }),
}));
