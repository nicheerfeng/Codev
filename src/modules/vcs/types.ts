export type VcsCounts = {
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
};

export type VcsEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  renameFrom?: string;
};

export type VcsRemoteInfo = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
};

export type VcsSnapshot = {
  snapshotId: number;
  worktreeRoot: string;
  commonGitDir: string;
  isWorktree: boolean;
  repoName: string;
  repoState:
    | "Normal"
    | "Merging"
    | "Rebasing"
    | "CherryPicking"
    | "Reverting"
    | "Detached"
    | "Empty"
    | string;
  headOid: string;
  branch: string;
  detached: boolean;
  empty: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  counts: VcsCounts;
  entries: VcsEntry[];
  remotes: VcsRemoteInfo[];
  authorConfigured: boolean;
  truncated: boolean;
};

export type VcsBranch = {
  name: string;
  fullName: string;
  remote?: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  commitOid: string;
  subject: string;
  worktreePath?: string;
};

export type VcsWorktree = {
  path: string;
  headOid: string;
  branch?: string;
  isMain: boolean;
  isLocked: boolean;
  lockReason?: string;
  prunable: boolean;
  sessionIds: string[];
};

export type VcsRefBadge = {
  label: string;
  kind: "head" | "local" | "remote" | "tag" | string;
};

export type VcsCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  email: string;
  timestamp: number;
  dateDisplay: string;
  refs: VcsRefBadge[];
};

export type VcsCommitFile = {
  path: string;
  status: string;
  oldPath?: string;
  additions: number;
  deletions: number;
};

export type VcsCommitDetail = {
  commit: VcsCommit;
  files: VcsCommitFile[];
};

export type VcsStashEntry = {
  index: number;
  refName: string;
  message: string;
  branch?: string;
  dateDisplay: string;
};

export type VcsDiffPayload = {
  path: string;
  originalLabel: string;
  modifiedLabel: string;
  original: string;
  modified: string;
  unified: string;
  truncated: boolean;
  binary: boolean;
};

export type VcsConflictVersions = {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  working: string;
  oursLabel: string;
  theirsLabel: string;
};

export type VcsDoctorIssue = {
  id: string;
  severity: "error" | "warning" | "info" | string;
  title: string;
  detail: string;
  fixable: boolean;
};

export type VcsDoctorReport = {
  gitInstalled: boolean;
  gitVersion?: string;
  gitPath?: string;
  isRepo: boolean;
  userName?: string;
  userEmail?: string;
  defaultBranch?: string;
  autocrlf?: string;
  pullRebase?: string;
  fetchPrune?: string;
  credentialHelper?: string;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  issues: VcsDoctorIssue[];
};

export type VcsTurnFileSummary = {
  path: string;
  status: string;
  staged: boolean;
  untracked: boolean;
};

export type VcsTurnDiffSummary = {
  turnId: string;
  worktreeRoot: string;
  branch: string;
  baseHeadOid: string;
  headOid: string;
  changedFiles: VcsTurnFileSummary[];
  newCommits: number;
  dirtyBefore: number;
  dirtyAfter: number;
};

export type ForgeRepoRef = {
  provider: string;
  host: string;
  owner: string;
  repo: string;
  fullName: string;
};

export type ForgeRepoOption = {
  fullName: string;
  owner: string;
  repo: string;
  host: string;
  private: boolean;
  openIssuesCount: number;
  updatedAt: string;
  localRoot?: string;
};

export type ForgeTarget =
  | string
  | {
      root?: string;
      repoFullName?: string;
      host?: string;
    };

export type ForgeAuthStatus = {
  source: "pat" | "gh" | "none" | string;
  authenticated: boolean;
  login?: string;
  hasSavedPat: boolean;
  ghInstalled: boolean;
};

export type ForgeLabel = {
  name: string;
  color: string;
};

export type ForgeNotification = {
  id: string;
  reason: string;
  unread: boolean;
  subjectType: string;
  title: string;
  number?: number;
  repoFullName: string;
  htmlUrl: string;
  updatedAt: string;
};

export type ForgeIssue = {
  id: number;
  number: number;
  title: string;
  state: string;
  body: string;
  author: string;
  labels: ForgeLabel[];
  commentsCount: number;
  updatedAt: string;
  htmlUrl: string;
  isAssignedToMe: boolean;
};

export type ForgeComment = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
};

export type ForgeCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  htmlUrl: string;
};

export type ForgePullRequest = {
  id: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  body: string;
  author: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  updatedAt: string;
  htmlUrl: string;
  checksStatus: "success" | "failure" | "pending" | "neutral" | string;
};

export type ForgePrFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type ForgeInboxSnapshot = {
  repo?: ForgeRepoRef;
  auth: ForgeAuthStatus;
  notifications: ForgeNotification[];
  issues: ForgeIssue[];
  pulls: ForgePullRequest[];
  unreadCount: number;
  lastSyncedAt: number;
  error?: string;
};

export type ParsedVcsError = {
  code: string | null;
  message: string;
};

export function parseVcsError(error: unknown): ParsedVcsError {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const match = raw.match(/^\[vcs:([A-Za-z0-9_]+)\]\s*(.*)$/s);
  if (!match) return { code: null, message: raw };
  return { code: match[1] ?? null, message: match[2] ?? raw };
}

export function normalizeVcsPath(path: string): string {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(forward) ? forward.toLowerCase() : forward;
}
