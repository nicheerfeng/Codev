import { create } from "zustand";
import { uiState } from "@/lib/uiState";
import { agentClient } from "@/modules/agent/client";
import { onHostEvent } from "@/modules/agent/hostEvents";
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
  type VcsWorktree,
} from "@/modules/vcs/types";

const FORGE_ACTIVE_REPO_KEY = "codev.forge.activeRepo";
const FORGE_REPOS_CACHE_KEY = "codev.forge.repos";
const FORGE_INBOXES_CACHE_KEY = "codev.forge.inboxes";
const MAX_CACHED_INBOX_REPOS = 6;
const MAX_CACHED_REPO_OPTIONS = 120;

const inflightForgeImages = new Map<string, Promise<string>>();
const resolvedForgeImages = new Map<string, string>();

function toForgeTargetPayload(target: ForgeTarget): {
  root?: string;
  repoFullName?: string;
  host?: string;
} {
  return typeof target === "string" ? { root: target } : target;
}

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

function computeTotalUnread(
  inboxes: Record<string, ForgeInboxSnapshot>,
): number {
  return Object.values(inboxes).reduce(
    (sum, inbox) => sum + (inbox.unreadCount ?? 0),
    0,
  );
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

export function forgeCommentsCacheKey(
  target: ForgeTarget,
  number: number,
): string {
  const payload = toForgeTargetPayload(target);
  const scope =
    payload.repoFullName?.toLowerCase() ||
    normalizeVcsPath(payload.root ?? "") ||
    "default";
  return `${scope}#${number}`;
}

function readInitialForgeCache() {
  const activeInboxRepo = uiState.getItem(FORGE_ACTIVE_REPO_KEY) || null;
  const cachedRepos = readUiJson<{
    repos?: ForgeRepoOption[];
    auth?: ForgeAuthStatus | null;
  }>(FORGE_REPOS_CACHE_KEY);
  const cachedInboxes = readUiJson<Record<string, ForgeInboxSnapshot>>(
    FORGE_INBOXES_CACHE_KEY,
  );
  const inboxes =
    cachedInboxes && typeof cachedInboxes === "object" ? cachedInboxes : {};
  return {
    activeInboxRepo,
    forgeRepos: Array.isArray(cachedRepos?.repos) ? cachedRepos.repos : [],
    forgeAuth: cachedRepos?.auth ?? null,
    inboxes,
    totalForgeUnread: computeTotalUnread(inboxes),
  };
}

export type ForgeStoreState = {
  inboxes: Record<string, ForgeInboxSnapshot>;
  forgeRepos: ForgeRepoOption[];
  forgeAuth: ForgeAuthStatus | null;
  forgeComments: Record<string, ForgeComment[]>;
  activeInboxRepo: string | null;
  totalForgeUnread: number;

  setActiveInboxRepo: (repoFullName: string | null) => void;
  hydrateForgeCache: () => void;
  applyForgeInboxes: (forgeInboxes?: ForgeInboxSnapshot[]) => void;
  applyForgeInbox: (inbox: ForgeInboxSnapshot) => void;

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
  fetchPrChecks: (target: ForgeTarget, sha: string) => Promise<ForgeCheckRun[]>;
  fetchPrFiles: (target: ForgeTarget, number: number) => Promise<ForgePrFile[]>;
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

const initialForgeCache = readInitialForgeCache();

export const useForgeStore = create<ForgeStoreState>((set, get) => ({
  inboxes: initialForgeCache.inboxes,
  forgeRepos: initialForgeCache.forgeRepos,
  forgeAuth: initialForgeCache.forgeAuth,
  forgeComments: {},
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
        forgeRepos:
          state.forgeRepos.length > 0 ? state.forgeRepos : cached.forgeRepos,
        forgeAuth: state.forgeAuth ?? cached.forgeAuth,
        inboxes: mergedInboxes,
        totalForgeUnread: computeTotalUnread(mergedInboxes),
      };
    });
  },

  applyForgeInboxes: (forgeInboxes) => {
    if (!forgeInboxes?.length) return;
    set((state) => {
      const nextInboxes = { ...state.inboxes };
      for (const inbox of forgeInboxes) {
        if (inbox.repo?.fullName) {
          nextInboxes[inbox.repo.fullName] = inbox;
        }
      }
      writeUiJson(FORGE_INBOXES_CACHE_KEY, trimInboxesForCache(nextInboxes));
      return {
        inboxes: nextInboxes,
        totalForgeUnread: computeTotalUnread(nextInboxes),
      };
    });
  },

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

// Register event bus subscriptions for host-pushed forge snapshots/updates.
onHostEvent("host.snapshot", ({ forgeInboxes }) => {
  useForgeStore.getState().applyForgeInboxes(forgeInboxes);
});
onHostEvent("forge.updated", ({ inbox }) => {
  useForgeStore.getState().applyForgeInbox(inbox);
});
