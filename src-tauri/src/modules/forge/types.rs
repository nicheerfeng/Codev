use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepoRef {
    pub provider: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub full_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepoOption {
    pub full_name: String,
    pub owner: String,
    pub repo: String,
    pub host: String,
    pub private: bool,
    pub open_issues_count: u64,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_root: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAuthStatus {
    /// pat | gh | none
    pub source: String,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub has_saved_pat: bool,
    pub gh_installed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLabel {
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeNotification {
    pub id: String,
    pub reason: String,
    pub unread: bool,
    pub subject_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    pub repo_full_name: String,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeIssue {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub body: String,
    pub author: String,
    pub labels: Vec<ForgeLabel>,
    pub comments_count: u64,
    pub updated_at: String,
    pub html_url: String,
    pub is_assigned_to_me: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub html_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeCheckRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    pub html_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgePullRequest {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub body: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub head_sha: String,
    pub updated_at: String,
    pub html_url: String,
    pub checks_status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgePrFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeInboxSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<ForgeRepoRef>,
    pub auth: ForgeAuthStatus,
    pub notifications: Vec<ForgeNotification>,
    pub issues: Vec<ForgeIssue>,
    pub pulls: Vec<ForgePullRequest>,
    pub unread_count: usize,
    pub last_synced_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
