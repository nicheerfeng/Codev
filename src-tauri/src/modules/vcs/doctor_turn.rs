//! Git environment diagnostics (`doctor_check` / `doctor_fix`) and agent turn-baseline diff tracking.
//! Extracted from `vcs/repo.rs` to keep core Git repository operations concise.

use super::process::{
    classify_error, git, git_binary, refresh_git_binary, run_raw, PromptPolicy,
};
use super::repo::{
    collect_numstat, count_untracked_lines, read_git_config, resolve_repo_context,
    TurnBaselineRecord, VcsService,
};
use super::types::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

impl VcsService {
    pub fn doctor_check(&self, root: Option<&str>) -> Result<VcsDoctorReport, String> {
        let mut ver_cmd = std::process::Command::new(refresh_git_binary());
        ver_cmd.arg("--version");
        crate::modules::proc::hide_console(&mut ver_cmd);
        let (git_installed, ver_out) = match run_raw(ver_cmd, None, Duration::from_secs(4)) {
            Ok((ok, out, _)) if ok => {
                (true, Some(String::from_utf8_lossy(&out).trim().to_string()))
            }
            _ => (false, None),
        };
        let repo_ctx = root.and_then(|r| resolve_repo_context(Path::new(r)).ok().flatten());
        let repo_path = repo_ctx.as_ref().map(|c| PathBuf::from(&c.worktree_root));
        let repo_ref = repo_path.as_deref();

        let user_name = read_git_config(repo_ref, "user.name");
        let user_email = read_git_config(repo_ref, "user.email");
        let default_branch = read_git_config(repo_ref, "init.defaultbranch");
        let autocrlf = read_git_config(repo_ref, "core.autocrlf");
        let pull_rebase = read_git_config(repo_ref, "pull.rebase");
        let fetch_prune = read_git_config(repo_ref, "fetch.prune");
        let credential_helper = read_git_config(repo_ref, "credential.helper");

        let mut gh_ver = std::process::Command::new("gh");
        gh_ver.arg("--version");
        crate::modules::proc::hide_console(&mut gh_ver);
        let gh_installed =
            run_raw(gh_ver, None, Duration::from_secs(3)).is_ok_and(|(ok, _, _)| ok);
        let gh_authenticated = if gh_installed {
            let mut gh_tok = std::process::Command::new("gh");
            gh_tok.args(["auth", "token"]);
            crate::modules::proc::hide_console(&mut gh_tok);
            run_raw(gh_tok, None, Duration::from_secs(4))
                .is_ok_and(|(ok, out, _)| ok && !String::from_utf8_lossy(&out).trim().is_empty())
        } else {
            false
        };

        let mut issues = Vec::new();
        if !git_installed {
            issues.push(VcsDoctorIssue {
                id: "git_missing".into(),
                severity: "error".into(),
                title: "未检测到 Git CLI".into(),
                detail: "请安装 Git（Windows 推荐 Git for Windows）并重启 Codev。".into(),
                fixable: false,
            });
        }
        if user_name.is_none() || user_email.is_none() {
            issues.push(VcsDoctorIssue {
                id: "identity".into(),
                severity: "error".into(),
                title: "未配置 Git 提交身份 (user.name / user.email)".into(),
                detail: "首次提交前必须设置作者姓名与邮箱。".into(),
                fixable: true,
            });
        }
        if cfg!(windows)
            && autocrlf.as_deref() != Some("input")
            && autocrlf.as_deref() != Some("false")
        {
            issues.push(VcsDoctorIssue {
                id: "autocrlf".into(),
                severity: "warning".into(),
                title: "建议将 Windows core.autocrlf 设为 input".into(),
                detail: "可防止换行符自动转换造成整文件虚假 Diff。".into(),
                fixable: true,
            });
        }
        if pull_rebase.is_none() {
            issues.push(VcsDoctorIssue {
                id: "pull_rebase".into(),
                severity: "info".into(),
                title: "推荐开启 pull.rebase = true 与 fetch.prune = true".into(),
                detail: "拉取更新时自动线性变基并清理已删除远端分支，分支图更清晰。".into(),
                fixable: true,
            });
        }
        if !gh_authenticated && credential_helper.is_none() {
            issues.push(VcsDoctorIssue {
                id: "forge_auth".into(),
                severity: "info".into(),
                title: "尚未检测到 gh 登录或凭据助手".into(),
                detail: "如使用 GitHub 收件箱同步 Issue/PR，可登录 `gh auth login` 或配置 PAT。"
                    .into(),
                fixable: false,
            });
        }

        Ok(VcsDoctorReport {
            git_installed,
            git_version: ver_out,
            git_path: Some(git_binary()),
            is_repo: repo_ctx.is_some(),
            user_name,
            user_email,
            default_branch,
            autocrlf,
            pull_rebase,
            fetch_prune,
            credential_helper,
            gh_installed,
            gh_authenticated,
            issues,
        })
    }

    pub fn doctor_fix(
        &self,
        user_name: Option<String>,
        user_email: Option<String>,
        apply_recommended: bool,
    ) -> Result<(), String> {
        let set_global = |key: &str, val: &str| -> Result<(), String> {
            let mut cmd = std::process::Command::new(git_binary());
            cmd.args(["config", "--global", key, val]);
            crate::modules::proc::hide_console(&mut cmd);
            let (ok, _, err) = run_raw(cmd, None, Duration::from_secs(5))?;
            if ok {
                Ok(())
            } else {
                Err(classify_error(&err).to_wire())
            }
        };
        if let Some(name) = user_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            set_global("user.name", name)?;
        }
        if let Some(email) = user_email
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            set_global("user.email", email)?;
        }
        if apply_recommended {
            set_global("init.defaultBranch", "main")?;
            set_global("pull.rebase", "true")?;
            set_global("fetch.prune", "true")?;
            if cfg!(windows) {
                set_global("core.autocrlf", "input")?;
            }
        }
        self.invalidate_repo_meta(None);
        Ok(())
    }

    pub fn begin_turn_baseline(&self, session_id: &str, turn_id: &str, cwd: &str) -> bool {
        self.suppressed_turns.lock().unwrap().remove(session_id);
        self.turn_baselines.lock().unwrap().remove(session_id);
        let Some(snap) = self.cached_snapshot_for(cwd) else {
            return false;
        };
        self.record_turn_baseline_from_snapshot(session_id, turn_id, snap);
        true
    }

    pub fn suppress_turn_baseline(&self, session_id: &str, turn_id: &str) {
        self.suppressed_turns
            .lock()
            .unwrap()
            .insert(session_id.to_string(), turn_id.to_string());
    }

    pub fn record_turn_baseline_from_snapshot(
        &self,
        session_id: &str,
        turn_id: &str,
        snap: VcsSnapshot,
    ) {
        if self
            .suppressed_turns
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|suppressed| suppressed == turn_id)
        {
            return;
        }
        let dirty_paths = snap
            .entries
            .into_iter()
            .map(|e| (e.path, format!("{}{}", e.index_status, e.worktree_status)))
            .collect::<HashMap<_, _>>();
        let dirty_before = dirty_paths.len();
        self.turn_baselines.lock().unwrap().insert(
            session_id.to_string(),
            TurnBaselineRecord {
                turn_id: turn_id.to_string(),
                worktree_root: snap.worktree_root,
                head_oid: snap.head_oid,
                dirty_paths,
                dirty_before,
            },
        );
    }

    pub fn capture_turn_baseline(&self, session_id: &str, turn_id: &str, cwd: &str) {
        self.suppressed_turns.lock().unwrap().remove(session_id);
        let Ok(Some(snap)) = self.snapshot(cwd) else {
            return;
        };
        self.record_turn_baseline_from_snapshot(session_id, turn_id, snap);
    }

    pub fn compute_turn_diff(&self, session_id: &str, cwd: &str) -> Option<VcsTurnDiffSummary> {
        self.compute_turn_diff_with_snapshot(session_id, cwd)
            .map(|(diff, _)| diff)
    }

    pub fn compute_turn_diff_with_snapshot(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Option<(VcsTurnDiffSummary, VcsSnapshot)> {
        let baseline = self
            .turn_baselines
            .lock()
            .unwrap()
            .get(session_id)?
            .clone();
        self.suppressed_turns
            .lock()
            .unwrap()
            .insert(session_id.to_string(), baseline.turn_id.clone());
        let snap = self.snapshot(cwd).ok().flatten()?;
        if snap.worktree_root != baseline.worktree_root {
            return None;
        }
        let repo = PathBuf::from(&snap.worktree_root);
        let numstat_worktree = collect_numstat(&repo, &["diff", "--numstat", "--"]);
        let numstat_staged = collect_numstat(&repo, &["diff", "--numstat", "--cached", "--"]);
        let numstat_head = if !baseline.head_oid.is_empty()
            && !snap.head_oid.is_empty()
            && baseline.head_oid != snap.head_oid
        {
            collect_numstat(&repo, &["diff", "--numstat", &baseline.head_oid, "HEAD"])
        } else {
            HashMap::new()
        };

        let mut changed_files = Vec::new();
        for entry in &snap.entries {
            let sig = format!("{}{}", entry.index_status, entry.worktree_status);
            let existed_same = baseline.dirty_paths.get(&entry.path) == Some(&sig);
            if !existed_same {
                let (additions, deletions) = if entry.untracked {
                    (count_untracked_lines(&repo.join(&entry.path)), 0)
                } else if let Some(&(a, d)) = numstat_worktree.get(&entry.path) {
                    let (sa, sd) = numstat_staged.get(&entry.path).copied().unwrap_or((0, 0));
                    (a.saturating_add(sa), d.saturating_add(sd))
                } else {
                    numstat_staged.get(&entry.path).copied().unwrap_or((0, 0))
                };
                changed_files.push(VcsTurnFileSummary {
                    path: entry.path.clone(),
                    status: sig,
                    staged: entry.staged,
                    untracked: entry.untracked,
                    additions,
                    deletions,
                });
            }
        }
        let mut new_commits = 0usize;
        if !baseline.head_oid.is_empty()
            && !snap.head_oid.is_empty()
            && baseline.head_oid != snap.head_oid
        {
            let range = format!("{}..HEAD", baseline.head_oid);
            if let Ok(out) = git(
                &repo,
                &["rev-list", "--count", &range],
                PromptPolicy::SilentRead,
                Duration::from_secs(4),
            ) {
                new_commits = out.trim().parse().unwrap_or(0);
            }
            if let Ok(committed) = git(
                &repo,
                &["diff", "--name-status", &baseline.head_oid, "HEAD"],
                PromptPolicy::SilentRead,
                Duration::from_secs(4),
            ) {
                let existing: HashSet<String> =
                    changed_files.iter().map(|f| f.path.clone()).collect();
                for line in committed.lines() {
                    let parts: Vec<&str> = line.split('\t').collect();
                    if parts.len() >= 2 {
                        let path = parts.last().unwrap().to_string();
                        if !existing.contains(&path) {
                            let (additions, deletions) =
                                numstat_head.get(&path).copied().unwrap_or((0, 0));
                            changed_files.push(VcsTurnFileSummary {
                                path,
                                status: parts[0].chars().take(2).collect(),
                                staged: false,
                                untracked: false,
                                additions,
                                deletions,
                            });
                        }
                    }
                }
            }
        }
        let dirty_after = snap.entries.len();
        let summary = VcsTurnDiffSummary {
            turn_id: baseline.turn_id,
            worktree_root: snap.worktree_root.clone(),
            branch: snap.branch.clone(),
            base_head_oid: baseline.head_oid.clone(),
            head_oid: snap.head_oid.clone(),
            changed_files,
            new_commits,
            dirty_before: baseline.dirty_before,
            dirty_after,
        };
        Some((summary, snap))
    }

    pub async fn revert_turn_changes(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        let Some(summary) = self.compute_turn_diff(session_id, cwd) else {
            return Err("未找到本轮基线记录，无法自动撤销".into());
        };
        if summary.new_commits > 0 {
            return Err(
                "本轮期间产生了新提交，请在 Git 历史面板中使用 Revert 安全回滚。".into(),
            );
        }
        let paths: Vec<String> = summary.changed_files.into_iter().map(|f| f.path).collect();
        if paths.is_empty() {
            return Ok(());
        }
        self.discard_files(&summary.worktree_root, paths).await
    }
}
