use super::{
    bridge::lock,
    coordinator::Host,
    protocol::*,
};
use crate::modules::forge::{github as gh_api, ForgeRepoOption, ForgeRepoRef, ForgeService};
use crate::modules::vcs::VcsService;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

fn resolve_forge_repo_with(
    vcs: &VcsService,
    repo_full_name: Option<&str>,
    host: Option<&str>,
    root_opt: Option<&str>,
) -> Result<ForgeRepoRef, String> {
    if let Some(full) = repo_full_name.map(str::trim).filter(|s| !s.is_empty()) {
        return gh_api::parse_repo_full_name(full, host)
            .ok_or_else(|| format!("无效的仓库名：{full}"));
    }
    let root = root_opt.filter(|s| !s.trim().is_empty()).ok_or("缺少仓库路径或仓库名")?;
    let snap = vcs.snapshot(root)?.ok_or("当前目录不是 Git 仓库")?;
    ForgeService::detect_repo(&snap).ok_or_else(|| "未检测到 GitHub 远程仓库".into())
}

impl Host {
    pub(super) fn resolve_vcs_root(&self, payload: &Value, session_id: Option<&str>) -> Result<String, String> {
        let root = text(payload, "root");
        if !root.trim().is_empty() {
            return Ok(root);
        }
        let wid = text(payload, "workspaceId");
        if !wid.trim().is_empty() {
            let st = lock(&self.state);
            if let Some(ws) = st.workspaces.get(&wid) {
                return Ok(ws.cwd.clone());
            }
        }
        if let Some(sid) = session_id {
            if let Some(cwd) = self.session_cwd(sid) {
                return Ok(cwd);
            }
        }
        Err("缺少仓库路径或工作区标识".into())
    }

    pub(super) async fn execute_vcs_or_forge(
        self: &Arc<Self>,
        principal: &Principal,
        command: &Command,
    ) -> Result<Value, String> {
        let op = command.operation.as_str();
        let payload = &command.payload;
        let sid_opt = command.session_id.as_deref();

        match op {
            "vcs.snapshot" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let vcs = self.vcs.clone();
                let snapshot = tokio::task::spawn_blocking(move || vcs.snapshot(&root))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(json!({ "snapshot": snapshot }))
            }
            "vcs.diff" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let path = text(payload, "path");
                let staged = payload.get("staged").and_then(Value::as_bool).unwrap_or(false);
                let vcs = self.vcs.clone();
                let diff = tokio::task::spawn_blocking(move || vcs.diff(&root, &path, staged))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(json!(diff))
            }
            "vcs.branches" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let vcs = self.vcs.clone();
                let branches = tokio::task::spawn_blocking(move || vcs.branches(&root))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(json!({ "branches": branches }))
            }
            "vcs.log" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let all = payload.get("all").and_then(Value::as_bool).unwrap_or(false);
                let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(80) as usize;
                let search = payload.get("search").and_then(Value::as_str).map(str::to_string);
                let vcs = self.vcs.clone();
                let commits =
                    tokio::task::spawn_blocking(move || vcs.log(&root, all, limit, search))
                        .await
                        .map_err(|e| e.to_string())??;
                Ok(json!({ "commits": commits }))
            }
            "vcs.commit.detail" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let hash = text(payload, "hash");
                let vcs = self.vcs.clone();
                let detail = tokio::task::spawn_blocking(move || vcs.commit_detail(&root, &hash))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(json!(detail))
            }
            "vcs.commit.diff" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let hash = text(payload, "hash");
                let path = text(payload, "path");
                let vcs = self.vcs.clone();
                let diff =
                    tokio::task::spawn_blocking(move || vcs.commit_file_diff(&root, &hash, &path))
                        .await
                        .map_err(|e| e.to_string())??;
                Ok(json!(diff))
            }
            "vcs.stash.list" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let vcs = self.vcs.clone();
                let stashes = tokio::task::spawn_blocking(move || vcs.stash_list(&root))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(json!({ "stashes": stashes }))
            }
            "vcs.worktree.list" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let (sessions, ws_cwds) = {
                    let st = lock(&self.state);
                    let sessions: Vec<(String, String)> = st
                        .sessions
                        .values()
                        .map(|v| (v.binding.id.clone(), v.binding.workspace_id.clone()))
                        .collect();
                    let cwds: HashMap<String, String> = st
                        .workspaces
                        .iter()
                        .map(|(k, w)| (k.clone(), w.cwd.clone()))
                        .collect();
                    (sessions, cwds)
                };
                let vcs = self.vcs.clone();
                let worktrees = tokio::task::spawn_blocking(move || {
                    vcs.worktree_list(&root, &sessions, &ws_cwds)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "worktrees": worktrees }))
            }
            "vcs.conflict.versions" => {
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let path = text(payload, "path");
                let vcs = self.vcs.clone();
                let conflict =
                    tokio::task::spawn_blocking(move || vcs.conflict_versions(&root, &path))
                        .await
                        .map_err(|e| e.to_string())??;
                Ok(json!(conflict))
            }
            "vcs.doctor.check" => {
                let root = payload
                    .get("root")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| self.resolve_vcs_root(payload, sid_opt).ok());
                let vcs = self.vcs.clone();
                let report =
                    tokio::task::spawn_blocking(move || vcs.doctor_check(root.as_deref()))
                        .await
                        .map_err(|e| e.to_string())??;
                Ok(json!(report))
            }
            "vcs.turn.diff" => {
                let sid = sid_opt.ok_or("缺少会话标识")?;
                let cwd = self.session_cwd(sid).ok_or("缺少会话工作目录")?;
                let vcs = self.vcs.clone();
                let sid_s = sid.to_string();
                let turn_git =
                    tokio::task::spawn_blocking(move || vcs.compute_turn_diff(&sid_s, &cwd))
                        .await
                        .map_err(|e| e.to_string())?;
                Ok(json!({ "turnGit": turn_git }))
            }
            "vcs.init" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let default_branch = payload
                    .get("defaultBranch")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let snapshot = self.vcs.init_repo(&root, default_branch).await?;
                self.sync_vcs_watchers();
                self.emit_event("vcs.changed", json!({ "snapshot": snapshot }));
                Ok(json!({ "snapshot": snapshot }))
            }
            "vcs.stage" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let paths: Vec<String> = payload
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let staged = payload.get("staged").and_then(Value::as_bool).unwrap_or(true);
                self.vcs.stage(&root, paths, staged).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.stage_all" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let staged = payload.get("staged").and_then(Value::as_bool).unwrap_or(true);
                self.vcs.stage_all(&root, staged).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.hunk" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let patch = text(payload, "patch");
                let cached = payload.get("cached").and_then(Value::as_bool).unwrap_or(false);
                let reverse = payload.get("reverse").and_then(Value::as_bool).unwrap_or(false);
                self.vcs.apply_hunk_patch(&root, patch, cached, reverse).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.discard" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let paths: Vec<String> = payload
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                self.vcs.discard_files(&root, paths).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.commit" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let message = text(payload, "message");
                let amend = payload.get("amend").and_then(Value::as_bool).unwrap_or(false);
                let also_push = payload.get("push").and_then(Value::as_bool).unwrap_or(false);
                let set_upstream = payload.get("setUpstream").and_then(Value::as_bool).unwrap_or(false);
                let output = self.vcs.commit(&root, message, amend).await?;
                if also_push {
                    self.vcs.push(&root, set_upstream).await?;
                }
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "output": output }))
            }
            "vcs.ai_commit" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let msg = crate::modules::vcs::ai_commit::generate_commit_message(&root).await?;
                Ok(json!({ "message": msg }))
            }
            "vcs.checkout" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let target = text(payload, "target");
                self.vcs.checkout(&root, target).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.branch.create" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let name = text(payload, "name");
                let start_point = payload
                    .get("startPoint")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let checkout = payload.get("checkout").and_then(Value::as_bool).unwrap_or(true);
                self.vcs
                    .create_branch(&root, name, start_point, checkout)
                    .await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.branch.delete" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let name = text(payload, "name");
                let force = payload.get("force").and_then(Value::as_bool).unwrap_or(false);
                let delete_remote = payload
                    .get("deleteRemote")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.vcs
                    .delete_branch(&root, name, force, delete_remote)
                    .await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.merge" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let source = text(payload, "source");
                let res = self.vcs.merge(&root, source).await;
                self.refresh_vcs_snapshot(&root).await;
                res.map(|output| json!({ "output": output }))
            }
            "vcs.rebase" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let upstream = text(payload, "upstream");
                let res = self.vcs.rebase(&root, upstream).await;
                self.refresh_vcs_snapshot(&root).await;
                res.map(|output| json!({ "output": output }))
            }
            "vcs.cherry_pick" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let hash = text(payload, "hash");
                let res = self.vcs.cherry_pick(&root, hash).await;
                self.refresh_vcs_snapshot(&root).await;
                res.map(|output| json!({ "output": output }))
            }
            "vcs.revert" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let hash = text(payload, "hash");
                let res = self.vcs.revert_commit(&root, hash).await;
                self.refresh_vcs_snapshot(&root).await;
                res.map(|output| json!({ "output": output }))
            }
            "vcs.op.continue" | "vcs.op.abort" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                self.vcs
                    .continue_or_abort(&root, op == "vcs.op.abort")
                    .await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.conflict.resolve" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let path = text(payload, "path");
                let strategy = text(payload, "strategy");
                let content = payload
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.vcs
                    .resolve_conflict(&root, &path, strategy, content)
                    .await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.stash.push" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let include_untracked = payload
                    .get("includeUntracked")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                self.vcs
                    .stash_push(&root, message, include_untracked)
                    .await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.stash.apply" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let pop = payload.get("pop").and_then(Value::as_bool).unwrap_or(false);
                self.vcs.stash_apply(&root, index, pop).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.stash.drop" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.vcs.stash_drop(&root, index).await?;
                Ok(json!({ "ok": true }))
            }
            "vcs.worktree.add" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let branch = text(payload, "branch");
                let create_branch = payload
                    .get("createBranch")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let start_point = payload
                    .get("startPoint")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let reason = payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let wt = self
                    .vcs
                    .worktree_add(&root, branch, create_branch, start_point, reason)
                    .await?;
                let workspace = self.workspace(&wt.path)?;
                self.refresh_vcs_snapshot(&wt.path).await;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "worktree": wt, "workspace": workspace }))
            }
            "vcs.worktree.remove" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let wt_path = text(payload, "path");
                let force = payload.get("force").and_then(Value::as_bool).unwrap_or(false);
                self.vcs.worktree_remove(&root, wt_path.clone(), force).await?;
                let matching_wids: Vec<String> = lock(&self.state)
                    .workspaces
                    .values()
                    .filter(|w| w.cwd.eq_ignore_ascii_case(&wt_path))
                    .map(|w| w.id.clone())
                    .collect();
                for wid in matching_wids {
                    let has_busy = lock(&self.state)
                        .sessions
                        .values()
                        .any(|v| v.binding.workspace_id == wid && v.busy());
                    if !has_busy {
                        let _ = lock(&self.store).remove_workspace(&wid);
                        let mut st = lock(&self.state);
                        st.workspaces.remove(&wid);
                        st.global_dirty = true;
                    }
                }
                self.sync_vcs_watchers();
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.worktree.session" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let branch = text(payload, "branch");
                let create_branch = payload
                    .get("createBranch")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let start_point = payload
                    .get("startPoint")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let harness_id = payload
                    .get("harnessId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("pi")
                    .to_string();
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Worktree · {branch}"));
                let wt = self
                    .vcs
                    .worktree_add(&root, branch, create_branch, start_point, Some(title.clone()))
                    .await?;
                let workspace = self.workspace(&wt.path)?;
                let sid = self.create(&workspace.id, &harness_id, &title)?;
                self.refresh_vcs_snapshot(&wt.path).await;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({
                    "worktree": wt,
                    "workspace": workspace,
                    "session": self.view(&sid)?,
                }))
            }
            "vcs.fetch" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let prune = payload.get("prune").and_then(Value::as_bool).unwrap_or(true);
                self.vcs.fetch(&root, prune).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.pull" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let rebase = payload.get("rebase").and_then(Value::as_bool);
                self.vcs.pull(&root, rebase).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.push" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let set_upstream = payload
                    .get("setUpstream")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.vcs.push(&root, set_upstream).await?;
                self.refresh_vcs_snapshot(&root).await;
                Ok(json!({ "ok": true }))
            }
            "vcs.doctor.fix" => {
                principal.require_desktop()?;
                let name = payload
                    .get("userName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let email = payload
                    .get("userEmail")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let apply_recommended = payload
                    .get("applyRecommended")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let vcs = self.vcs.clone();
                tokio::task::spawn_blocking(move || {
                    vcs.doctor_fix(name, email, apply_recommended)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "ok": true }))
            }
            "vcs.turn.revert" => {
                self.require_vcs_write(principal)?;
                let sid = sid_opt.ok_or("缺少会话标识")?;
                let cwd = self.session_cwd(sid).ok_or("缺少会话工作目录")?;
                self.vcs.revert_turn_changes(sid, &cwd).await?;
                if let Ok(rt) = self.view(sid) {
                    let sid_clone = sid.to_string();
                    self.update(&sid_clone, rt.instance_id.as_deref(), |v| {
                        v.statuses.remove("turnGit");
                    });
                }
                self.refresh_vcs_snapshot(&cwd).await;
                Ok(json!({ "ok": true }))
            }
            "forge.repos" => {
                let extra_roots: Vec<String> = payload
                    .get("roots")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let workspace_cwds: Vec<String> = {
                    let st = lock(&self.state);
                    st.workspaces.values().map(|w| w.cwd.clone()).collect()
                };
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let (repos, auth) = tokio::task::spawn_blocking(move || {
                    for dir in extra_roots.into_iter().chain(workspace_cwds.into_iter()) {
                        let _ = vcs.snapshot(&dir);
                    }
                    let mut local_map: HashMap<String, (ForgeRepoRef, String)> = HashMap::new();
                    for snap in vcs.cached_snapshots() {
                        if let Some(repo) = ForgeService::detect_repo(&snap) {
                            local_map
                                .entry(repo.full_name.to_ascii_lowercase())
                                .or_insert((repo, snap.worktree_root));
                        }
                    }
                    let (auth, token) = forge.resolve_token();
                    let remote_repos = token
                        .as_deref()
                        .and_then(|tok| gh_api::fetch_user_repos(tok).ok())
                        .unwrap_or_default();

                    let mut merged: Vec<ForgeRepoOption> = Vec::new();
                    let mut seen = std::collections::HashSet::new();
                    for (_, (repo, local_root)) in local_map.iter() {
                        let key = repo.full_name.to_ascii_lowercase();
                        if !seen.insert(key) {
                            continue;
                        }
                        let matched = remote_repos
                            .iter()
                            .find(|r| r.full_name.eq_ignore_ascii_case(&repo.full_name));
                        merged.push(ForgeRepoOption {
                            full_name: matched
                                .map(|r| r.full_name.clone())
                                .unwrap_or_else(|| repo.full_name.clone()),
                            owner: repo.owner.clone(),
                            repo: repo.repo.clone(),
                            host: repo.host.clone(),
                            private: matched.is_some_and(|r| r.private),
                            open_issues_count: matched.map_or(0, |r| r.open_issues_count),
                            updated_at: matched
                                .map(|r| r.updated_at.clone())
                                .unwrap_or_default(),
                            local_root: Some(local_root.clone()),
                        });
                    }
                    for mut r in remote_repos {
                        let key = r.full_name.to_ascii_lowercase();
                        if seen.insert(key) {
                            r.local_root = local_map
                                .get(&r.full_name.to_ascii_lowercase())
                                .map(|(_, p)| p.clone());
                            merged.push(r);
                        }
                    }
                    (merged, auth)
                })
                .await
                .map_err(|e| e.to_string())?;
                Ok(json!({ "repos": repos, "auth": auth }))
            }
            "forge.inbox" | "forge.sync" => {
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload
                    .get("host")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let state_filter = payload
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("open")
                    .to_string();
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let force = op == "forge.sync";
                let inbox = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = if let Some(full) = repo_full_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        gh_api::parse_repo_full_name(full, host.as_deref())
                    } else if let Some(ref root) = root_opt {
                        vcs.snapshot(root)?
                            .as_ref()
                            .and_then(ForgeService::detect_repo)
                    } else {
                        None
                    };
                    if !force {
                        if let Some(ref r) = repo {
                            if let Some(cached) = forge.cached_for(&r.full_name, &state_filter) {
                                return Ok(cached);
                            }
                        }
                    }
                    Ok(forge.sync_repo(repo, &state_filter))
                })
                .await
                .map_err(|e| e.to_string())??;
                if force {
                    self.emit_event("forge.updated", json!({ "inbox": inbox }));
                }
                Ok(json!(inbox))
            }
            "forge.auth.status" => {
                let forge = self.forge.clone();
                let (auth, _) = tokio::task::spawn_blocking(move || forge.resolve_token())
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!(auth))
            }
            "forge.pat.set" => {
                principal.require_desktop()?;
                let token = text(payload, "token");
                let cleaned = token.trim().to_string();
                lock(&self.store).set_preference("forgePat", &json!(cleaned))?;
                self.forge.set_pat((!cleaned.is_empty()).then_some(cleaned));
                let forge = self.forge.clone();
                let (auth, _) = tokio::task::spawn_blocking(move || forge.resolve_token())
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!(auth))
            }
            "forge.comments" => {
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let number = payload.get("number").and_then(Value::as_u64).ok_or("缺少编号")?;
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let comments = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    gh_api::fetch_comments(&repo, tok.as_deref(), number)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "comments": comments }))
            }
            "forge.pr.checks" => {
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let sha = text(payload, "sha");
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let checks = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    gh_api::fetch_pr_checks(&repo, tok.as_deref(), &sha)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "checks": checks }))
            }
            "forge.pr.files" => {
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let number = payload.get("number").and_then(Value::as_u64).ok_or("缺少 PR 编号")?;
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let files = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    gh_api::fetch_pr_files(&repo, tok.as_deref(), number)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "files": files }))
            }
            "forge.image" => {
                let url = text(payload, "url");
                if url.trim().is_empty() {
                    return Err("缺少图片地址".into());
                }
                if let Some(cached) = self.forge.cached_image(&url) {
                    return Ok(json!({ "dataUrl": cached }));
                }
                let forge = self.forge.clone();
                let data_url = tokio::task::spawn_blocking(move || -> Result<String, String> {
                    if let Some(cached) = forge.cached_image(&url) {
                        return Ok(cached);
                    }
                    let (_, tok) = forge.resolve_token();
                    let fetched = gh_api::fetch_github_image(&url, tok.as_deref())?;
                    forge.cache_image(&url, fetched.clone());
                    Ok(fetched)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "dataUrl": data_url }))
            }
            "forge.comment.create" => {
                self.require_vcs_write(principal)?;
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let number = payload.get("number").and_then(Value::as_u64).ok_or("缺少编号")?;
                let body = text(payload, "body");
                if body.trim().is_empty() {
                    return Err("评论内容不能为空".into());
                }
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let comment = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    let token = tok.ok_or("需要先配置 GitHub PAT 或登录 gh CLI 才能发表评论")?;
                    gh_api::create_comment(&repo, &token, number, &body)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "comment": comment }))
            }
            "forge.issue.create" => {
                self.require_vcs_write(principal)?;
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let title = text(payload, "title");
                let body = text(payload, "body");
                if title.trim().is_empty() {
                    return Err("Issue 标题不能为空".into());
                }
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let issue = tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    let token = tok.ok_or("需要先配置 GitHub PAT 或登录 gh CLI 才能创建 Issue")?;
                    gh_api::create_issue(&repo, &token, &title, &body)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "issue": issue }))
            }
            "forge.issue.state" => {
                self.require_vcs_write(principal)?;
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let number = payload.get("number").and_then(Value::as_u64).ok_or("缺少编号")?;
                let state = text(payload, "state");
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    let token = tok.ok_or("需要先配置 GitHub PAT 或登录 gh CLI 才能变更状态")?;
                    gh_api::set_issue_state(&repo, &token, number, &state)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "ok": true }))
            }
            "forge.pr.merge" => {
                self.require_vcs_write(principal)?;
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let number = payload.get("number").and_then(Value::as_u64).ok_or("缺少 PR 编号")?;
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("squash")
                    .to_string();
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )?;
                    let (_, tok) = forge.resolve_token();
                    let token = tok.ok_or("需要先配置 GitHub PAT 或登录 gh CLI 才能合并 PR")?;
                    gh_api::merge_pull_request(&repo, &token, number, &method)
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "ok": true }))
            }
            "forge.notification.read" => {
                self.require_vcs_write(principal)?;
                let id = text(payload, "id");
                let root_opt = self.resolve_vcs_root(payload, sid_opt).ok();
                let repo_full_name = payload
                    .get("repoFullName")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let host = payload.get("host").and_then(Value::as_str).map(str::to_string);
                let ids = self.forge.mark_local_read(&id);
                let _ = lock(&self.store).set_preference("forgeReadIds", &json!(ids));
                let vcs = self.vcs.clone();
                let forge = self.forge.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let repo = resolve_forge_repo_with(
                        &vcs,
                        repo_full_name.as_deref(),
                        host.as_deref(),
                        root_opt.as_deref(),
                    )
                    .unwrap_or(ForgeRepoRef {
                        provider: "github".into(),
                        host: "github.com".into(),
                        owner: "github".into(),
                        repo: "github".into(),
                        full_name: "github/github".into(),
                    });
                    let (_, tok) = forge.resolve_token();
                    if let Some(token) = tok {
                        let _ = gh_api::mark_notification_read(&repo, &token, &id);
                    }
                })
                .await;
                Ok(json!({ "ok": true }))
            }
            "forge.dispatch_agent" => {
                self.require_vcs_write(principal)?;
                let root = self.resolve_vcs_root(payload, sid_opt)?;
                let kind = text(payload, "kind");
                let number = payload.get("number").and_then(Value::as_u64).unwrap_or(0);
                let title = text(payload, "title");
                let body = text(payload, "body");
                let html_url = text(payload, "htmlUrl");
                let harness_id = payload
                    .get("harnessId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("pi")
                    .to_string();
                let base_branch = payload
                    .get("baseBranch")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let branch_prefix = if kind == "pr" { "pr" } else { "issue" };
                let branch = format!("codev/{branch_prefix}-{number}");
                let session_title = format!("#{number} {title}");
                let wt = self
                    .vcs
                    .worktree_add(
                        &root,
                        branch,
                        true,
                        base_branch,
                        Some(format!("Forge #{number}: {title}")),
                    )
                    .await?;
                let workspace = self.workspace(&wt.path)?;
                let sid = self.create(&workspace.id, &harness_id, &session_title)?;
                let initial_prompt = format!(
                    "请处理来自 Git 仓库的 {} #{}：{}\n链接：{}\n\n详情：\n{}\n\n请先核对仓库相关代码并完成修复/实现，自测通过后告知我可以提交并推送的改动摘要。",
                    if kind == "pr" { "Pull Request" } else { "Issue" },
                    number,
                    title,
                    html_url,
                    if body.trim().is_empty() { "（无附加正文）" } else { body.trim() }
                );
                self.refresh_vcs_snapshot(&wt.path).await;
                Ok(json!({
                    "worktree": wt,
                    "workspace": workspace,
                    "session": self.view(&sid)?,
                    "initialPrompt": initial_prompt,
                }))
            }
            _ => Err(format!("不支持的 VCS/Forge 操作：{op}")),
        }
    }
}
