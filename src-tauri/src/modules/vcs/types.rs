use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRepoContext {
    pub worktree_root: String,
    pub common_git_dir: String,
    pub git_dir: String,
    pub is_worktree: bool,
    pub repo_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCounts {
    pub staged: usize,
    pub modified: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsEntry {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_from: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsSnapshot {
    pub snapshot_id: u64,
    pub worktree_root: String,
    pub common_git_dir: String,
    pub is_worktree: bool,
    pub repo_name: String,
    /// Normal | Merging | Rebasing | CherryPicking | Reverting | Detached | Empty
    pub repo_state: String,
    pub head_oid: String,
    pub branch: String,
    pub detached: bool,
    pub empty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub counts: VcsCounts,
    pub entries: Vec<VcsEntry>,
    pub remotes: Vec<VcsRemoteInfo>,
    pub author_configured: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsBranch {
    pub name: String,
    pub full_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    pub is_current: bool,
    pub is_remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub commit_oid: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsWorktree {
    pub path: String,
    pub head_oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub session_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRefBadge {
    pub label: String,
    /// head | local | remote | tag
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCommit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub date_display: String,
    pub refs: Vec<VcsRefBadge>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCommitFile {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCommitDetail {
    pub commit: VcsCommit,
    pub files: Vec<VcsCommitFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsStashEntry {
    pub index: usize,
    pub ref_name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub date_display: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsDiffPayload {
    pub path: String,
    pub original_label: String,
    pub modified_label: String,
    pub original: String,
    pub modified: String,
    pub unified: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsConflictVersions {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub working: String,
    pub ours_label: String,
    pub theirs_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsDoctorIssue {
    pub id: String,
    /// error | warning | info
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub fixable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsDoctorReport {
    pub git_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_path: Option<String>,
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autocrlf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_rebase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_prune: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_helper: Option<String>,
    pub gh_installed: bool,
    pub gh_authenticated: bool,
    pub issues: Vec<VcsDoctorIssue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsTurnFileSummary {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub untracked: bool,
    #[serde(default)]
    pub additions: usize,
    #[serde(default)]
    pub deletions: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsTurnDiffSummary {
    pub turn_id: String,
    pub worktree_root: String,
    pub branch: String,
    pub base_head_oid: String,
    pub head_oid: String,
    pub changed_files: Vec<VcsTurnFileSummary>,
    pub new_commits: usize,
    pub dirty_before: usize,
    pub dirty_after: usize,
}
