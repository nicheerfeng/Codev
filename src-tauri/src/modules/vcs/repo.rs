use super::process::{
    classify_error, command, git, git_binary, git_bytes, git_with_stdin, has_head, run_raw,
    PromptPolicy, VcsError, VcsErrorCode, MAX_DIFF_BYTES, MAX_STATUS_ENTRIES,
};
use super::types::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const READ_TIMEOUT: Duration = Duration::from_secs(12);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(300);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
struct TurnBaselineRecord {
    turn_id: String,
    worktree_root: String,
    head_oid: String,
    dirty_paths: HashMap<String, String>,
    dirty_before: usize,
}

pub struct VcsService {
    snapshot_seq: AtomicU64,
    snapshots: Mutex<HashMap<String, VcsSnapshot>>,
    write_slots: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    turn_baselines: Mutex<HashMap<String, TurnBaselineRecord>>,
}

impl Default for VcsService {
    fn default() -> Self {
        Self {
            snapshot_seq: AtomicU64::new(1),
            snapshots: Mutex::new(HashMap::new()),
            write_slots: Mutex::new(HashMap::new()),
            turn_baselines: Mutex::new(HashMap::new()),
        }
    }
}

fn canon_path(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("无法解析路径 {}: {e}", path.display()))
}

fn display_path(path: &Path) -> String {
    crate::modules::fs::to_canon(path)
}

fn path_key(path: &Path) -> String {
    let text = display_path(path).trim_end_matches('/').to_string();
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

/// Resolve `.git` directory or worktree `.git` file (`gitdir:` + `commondir`) without trusting arbitrary traversal.
pub fn resolve_repo_context(input: &Path) -> Result<Option<VcsRepoContext>, String> {
    if !input.exists() {
        return Ok(None);
    }
    let canon = canon_path(input)?;
    let mut cursor = canon.as_path();
    let dot_git = loop {
        let candidate = cursor.join(".git");
        if candidate.exists() {
            break candidate;
        }
        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => return Ok(None),
        }
    };
    let worktree_root_path = dot_git
        .parent()
        .ok_or_else(|| "无效的仓库根目录".to_string())?;
    let (git_dir_path, common_git_dir_path, is_worktree) = if dot_git.is_dir() {
        let g = canon_path(&dot_git)?;
        (g.clone(), g, false)
    } else if dot_git.is_file() {
        let raw = std::fs::read_to_string(&dot_git).map_err(|e| e.to_string())?;
        let gitdir_spec = raw
            .lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))
            .map(str::trim)
            .ok_or_else(|| "Worktree .git 文件缺少 gitdir 字段".to_string())?;
        let raw_git_dir = PathBuf::from(gitdir_spec);
        let resolved_git_dir = if raw_git_dir.is_absolute() {
            canon_path(&raw_git_dir)?
        } else {
            canon_path(&worktree_root_path.join(raw_git_dir))?
        };
        let commondir_file = resolved_git_dir.join("commondir");
        let common = if commondir_file.is_file() {
            let rel = std::fs::read_to_string(&commondir_file)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            let rel_path = PathBuf::from(rel);
            if rel_path.is_absolute() {
                canon_path(&rel_path)?
            } else {
                canon_path(&resolved_git_dir.join(rel_path))?
            }
        } else {
            resolved_git_dir.clone()
        };
        let is_wt = resolved_git_dir != common;
        (resolved_git_dir, common, is_wt)
    } else {
        return Ok(None);
    };

    let repo_name = common_git_dir_path
        .parent()
        .and_then(|p| p.file_name())
        .or_else(|| worktree_root_path.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| display_path(worktree_root_path));

    Ok(Some(VcsRepoContext {
        worktree_root: display_path(worktree_root_path),
        common_git_dir: display_path(&common_git_dir_path),
        git_dir: display_path(&git_dir_path),
        is_worktree,
        repo_name,
    }))
}

pub fn ensure_repo_context(input: &Path) -> Result<VcsRepoContext, String> {
    resolve_repo_context(input)?.ok_or_else(|| {
        VcsError::new(
            VcsErrorCode::NotARepo,
            "当前目录不是 Git 仓库",
            "可以在 Git 面板点击初始化 Git 仓库。",
        )
        .to_wire()
    })
}

fn validate_rel_path(rel: &str) -> Result<String, String> {
    let trimmed = rel.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("文件路径不能为空".into());
    }
    let p = Path::new(&trimmed);
    if p.is_absolute() {
        return Err("只允许传入仓库内相对路径".into());
    }
    for comp in p.components() {
        if matches!(comp, Component::ParentDir | Component::RootDir | Component::Prefix(_)) {
            return Err(format!("非法仓库路径：{trimmed}"));
        }
    }
    Ok(trimmed)
}

fn detect_repo_state(git_dir: &Path, branch: &str, empty: bool, detached: bool) -> String {
    if git_dir.join("MERGE_HEAD").exists() {
        "Merging".into()
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        "Rebasing".into()
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "CherryPicking".into()
    } else if git_dir.join("REVERT_HEAD").exists() {
        "Reverting".into()
    } else if empty && branch.is_empty() {
        "Empty".into()
    } else if detached {
        "Detached".into()
    } else {
        "Normal".into()
    }
}

fn format_bytes_capped(bytes: &[u8]) -> (String, bool, bool) {
    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0) {
        return (String::new(), false, true);
    }
    if bytes.len() > MAX_DIFF_BYTES {
        let text = String::from_utf8_lossy(&bytes[..MAX_DIFF_BYTES]).into_owned();
        return (text, true, false);
    }
    (String::from_utf8_lossy(bytes).into_owned(), false, false)
}

pub(crate) fn parse_status_z(raw: &str) -> (Vec<VcsEntry>, VcsCounts, bool) {
    let mut tokens = raw.split('\0').peekable();
    let mut entries = Vec::new();
    let mut counts = VcsCounts::default();
    let mut truncated = false;

    while let Some(token) = tokens.next() {
        if token.len() < 4 {
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        let bytes = token.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &token[3..];
        let rename_from = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            tokens.next().filter(|s| !s.is_empty()).map(str::to_string)
        } else {
            None
        };
        let untracked = x == '?' && y == '?';
        let conflicted = matches!(
            (x, y),
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')
        );
        let staged = !untracked && !conflicted && x != ' ';
        let unstaged = !untracked && !conflicted && y != ' ';
        if conflicted {
            counts.conflicted += 1;
        } else {
            if staged {
                counts.staged += 1;
            }
            if untracked {
                counts.untracked += 1;
            } else if unstaged {
                counts.modified += 1;
            }
        }
        entries.push(VcsEntry {
            path: path.to_string(),
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            staged,
            unstaged,
            untracked,
            conflicted,
            rename_from,
        });
    }
    (entries, counts, truncated)
}

fn parse_tracking_counts(repo: &Path) -> (Option<String>, u32, u32) {
    let Ok(upstream) = git(
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        PromptPolicy::SilentRead,
        Duration::from_secs(4),
    ) else {
        return (None, 0, 0);
    };
    let upstream = upstream.trim().to_string();
    if upstream.is_empty() {
        return (None, 0, 0);
    }
    let Ok(lr) = git(
        repo,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        PromptPolicy::SilentRead,
        Duration::from_secs(4),
    ) else {
        return (Some(upstream), 0, 0);
    };
    let mut parts = lr.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    (Some(upstream), ahead, behind)
}

fn parse_remotes(repo: &Path) -> Vec<VcsRemoteInfo> {
    let Ok(out) = git(
        repo,
        &["remote", "-v"],
        PromptPolicy::SilentRead,
        Duration::from_secs(4),
    ) else {
        return vec![];
    };
    let mut map: BTreeMap<String, VcsRemoteInfo> = BTreeMap::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let entry = map.entry(name.to_string()).or_insert_with(|| VcsRemoteInfo {
            name: name.to_string(),
            fetch_url: String::new(),
            push_url: String::new(),
        });
        if kind.contains("fetch") {
            entry.fetch_url = url.to_string();
        } else if kind.contains("push") {
            entry.push_url = url.to_string();
        }
    }
    map.into_values().collect()
}

fn read_git_config(repo: Option<&Path>, key: &str) -> Option<String> {
    let cmd = if let Some(cwd) = repo {
        command(cwd, &["config", "--get", key], PromptPolicy::SilentRead, false)
    } else {
        let mut c = std::process::Command::new(git_binary());
        c.args(["config", "--global", "--get", key]);
        crate::modules::proc::hide_console(&mut c);
        c
    };
    let (ok, out, _) = run_raw(cmd, None, Duration::from_secs(3)).ok()?;
    if !ok {
        return None;
    }
    let text = String::from_utf8_lossy(&out).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn parse_ref_badges(raw_refs: &str, head_branch: &str) -> Vec<VcsRefBadge> {
    if raw_refs.trim().is_empty() {
        return vec![];
    }
    raw_refs
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| {
            if let Some(target) = token.strip_prefix("HEAD -> ") {
                VcsRefBadge {
                    label: format!("HEAD -> {}", target.trim()),
                    kind: "head".into(),
                }
            } else if token == "HEAD" {
                VcsRefBadge {
                    label: "HEAD".into(),
                    kind: "head".into(),
                }
            } else if let Some(tag) = token.strip_prefix("tag: ") {
                VcsRefBadge {
                    label: tag.trim().to_string(),
                    kind: "tag".into(),
                }
            } else if token.contains('/') && !token.starts_with("feat/") && !token.starts_with("fix/") && !token.starts_with("codev/") {
                VcsRefBadge {
                    label: token.to_string(),
                    kind: if !head_branch.is_empty() && token.ends_with(&format!("/{head_branch}")) {
                        "remote".into()
                    } else {
                        "remote".into()
                    },
                }
            } else {
                VcsRefBadge {
                    label: token.to_string(),
                    kind: "local".into(),
                }
            }
        })
        .collect()
}

fn slugify_branch_segment(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "task".into()
    } else {
        trimmed.chars().take(48).collect()
    }
}

impl VcsService {
    fn write_slot(&self, common_git_dir: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut slots = self.write_slots.lock().unwrap();
        slots
            .entry(common_git_dir.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn cached_snapshots(&self) -> Vec<VcsSnapshot> {
        self.snapshots.lock().unwrap().values().cloned().collect()
    }

    pub fn snapshot(&self, root: &str) -> Result<Option<VcsSnapshot>, String> {
        let Some(ctx) = resolve_repo_context(Path::new(root))? else {
            return Ok(None);
        };
        let repo = PathBuf::from(&ctx.worktree_root);
        let git_dir = PathBuf::from(&ctx.git_dir);
        let has_commit = has_head(&repo)?;
        let head_oid = if has_commit {
            git(&repo, &["rev-parse", "--short=12", "HEAD"], PromptPolicy::SilentRead, READ_TIMEOUT)
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let branch_name = git(
            &repo,
            &["symbolic-ref", "--short", "-q", "HEAD"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
        let detached = has_commit && branch_name.is_empty();
        let branch = if !branch_name.is_empty() {
            branch_name.clone()
        } else if !head_oid.is_empty() {
            format!("HEAD@{head_oid}")
        } else {
            git(
                &repo,
                &["branch", "--show-current"],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "main".into())
        };
        let raw_status = git(
            &repo,
            &["status", "--porcelain=v1", "-z", "-uall"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let (entries, counts, truncated) = parse_status_z(&raw_status);
        let empty = !has_commit && entries.is_empty();
        let repo_state = detect_repo_state(&git_dir, &branch_name, empty, detached);
        let (upstream, ahead, behind) = if has_commit && !detached {
            parse_tracking_counts(&repo)
        } else {
            (None, 0, 0)
        };
        let remotes = parse_remotes(&repo);
        let author_configured = read_git_config(Some(&repo), "user.name").is_some()
            && read_git_config(Some(&repo), "user.email").is_some();

        let snapshot = VcsSnapshot {
            snapshot_id: self.snapshot_seq.fetch_add(1, Ordering::Relaxed),
            worktree_root: ctx.worktree_root.clone(),
            common_git_dir: ctx.common_git_dir,
            is_worktree: ctx.is_worktree,
            repo_name: ctx.repo_name,
            repo_state,
            head_oid,
            branch,
            detached,
            empty,
            upstream,
            ahead,
            behind,
            counts,
            entries,
            remotes,
            author_configured,
            truncated,
        };
        self.snapshots
            .lock()
            .unwrap()
            .insert(path_key(Path::new(&snapshot.worktree_root)), snapshot.clone());
        Ok(Some(snapshot))
    }

    pub fn diff(&self, root: &str, rel_path: &str, staged: bool) -> Result<VcsDiffPayload, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let rel = validate_rel_path(rel_path)?;
        let has_commit = has_head(&repo)?;

        let original_bytes = if staged {
            if has_commit {
                git_bytes(
                    &repo,
                    &["show", &format!("HEAD:{rel}")],
                    PromptPolicy::SilentRead,
                    READ_TIMEOUT,
                )
                .unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            git_bytes(
                &repo,
                &["show", &format!(":{rel}")],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )
            .unwrap_or_else(|_| {
                if has_commit {
                    git_bytes(
                        &repo,
                        &["show", &format!("HEAD:{rel}")],
                        PromptPolicy::SilentRead,
                        READ_TIMEOUT,
                    )
                    .unwrap_or_default()
                } else {
                    Vec::new()
                }
            })
        };

        let modified_bytes = if staged {
            git_bytes(
                &repo,
                &["show", &format!(":{rel}")],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )
            .unwrap_or_default()
        } else {
            let full = repo.join(&rel);
            std::fs::read(&full).unwrap_or_default()
        };

        let (original, trunc_orig, bin_orig) = format_bytes_capped(&original_bytes);
        let (modified, trunc_mod, bin_mod) = format_bytes_capped(&modified_bytes);
        let binary = bin_orig || bin_mod;

        let unified = if binary {
            String::new()
        } else {
            let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
            if staged {
                args.push("--cached");
            }
            args.push("--");
            args.push(&rel);
            let out = git(&repo, &args, PromptPolicy::SilentRead, READ_TIMEOUT).unwrap_or_default();
            if out.trim().is_empty() && !staged && original_bytes.is_empty() && !modified.is_empty() {
                // Untracked file unified synth
                let lines: Vec<String> = modified.lines().map(|l| format!("+{l}")).collect();
                format!(
                    "diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n{}",
                    lines.len(),
                    lines.join("\n")
                )
            } else if out.len() > MAX_DIFF_BYTES {
                out.chars().take(MAX_DIFF_BYTES).collect()
            } else {
                out
            }
        };

        Ok(VcsDiffPayload {
            path: rel,
            original_label: if staged { "HEAD".into() } else { "暂存区 / Index".into() },
            modified_label: if staged { "暂存区 / Index".into() } else { "工作区 / Working Tree".into() },
            original,
            modified,
            unified,
            truncated: trunc_orig || trunc_mod,
            binary,
        })
    }

    pub async fn stage(&self, root: &str, paths: Vec<String>, staged: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let clean: Vec<String> = paths
            .into_iter()
            .filter_map(|p| validate_rel_path(&p).ok())
            .collect();
        if clean.is_empty() {
            return Ok(());
        }
        tokio::task::spawn_blocking(move || {
            let mut args: Vec<String> = if staged {
                vec!["add".into(), "-A".into(), "--".into()]
            } else if has_head(&repo)? {
                vec!["reset".into(), "-q".into(), "HEAD".into(), "--".into()]
            } else {
                vec!["rm".into(), "--cached".into(), "-r".into(), "-q".into(), "--".into()]
            };
            args.extend(clean);
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            git(&repo, &refs, PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn stage_all(&self, root: &str, staged: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            if staged {
                git(&repo, &["add", "-A"], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            } else if has_head(&repo)? {
                git(&repo, &["reset", "-q", "HEAD"], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            } else {
                git(&repo, &["rm", "--cached", "-r", "-q", "."], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn apply_hunk_patch(
        &self,
        root: &str,
        patch: String,
        cached: bool,
        reverse: bool,
    ) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
            if cached {
                args.push("--cached");
            }
            if reverse {
                args.push("--reverse");
            }
            args.push("-");
            let patch_bytes = if patch.ends_with('\n') {
                patch
            } else {
                format!("{patch}\n")
            };
            git_with_stdin(
                &repo,
                &args,
                patch_bytes.as_bytes(),
                PromptPolicy::SilentRead,
                WRITE_TIMEOUT,
            )?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn discard_files(&self, root: &str, paths: Vec<String>) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let clean: Vec<String> = paths
            .into_iter()
            .filter_map(|p| validate_rel_path(&p).ok())
            .collect();
        if clean.is_empty() {
            return Ok(());
        }
        tokio::task::spawn_blocking(move || {
            let status_raw = git(
                &repo,
                &["status", "--porcelain=v1", "-z", "-uall"],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )?;
            let (entries, _, _) = parse_status_z(&status_raw);
            let mut tracked = Vec::new();
            let mut untracked = Vec::new();
            for p in clean {
                if entries.iter().any(|e| e.path == p && e.untracked) {
                    untracked.push(p);
                } else {
                    tracked.push(p);
                }
            }
            if !tracked.is_empty() {
                let mut args = vec!["checkout".to_string(), "--".to_string()];
                args.extend(tracked);
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                git(&repo, &refs, PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            }
            for rel in untracked {
                let target = repo.join(&rel);
                if target.exists() {
                    if let Err(_) = trash::delete(&target) {
                        if target.is_dir() {
                            std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
                        } else {
                            std::fs::remove_file(&target).map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn commit(&self, root: &str, message: String, amend: bool) -> Result<String, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let msg = message.trim().to_string();
        if msg.is_empty() {
            return Err("请输入提交说明".into());
        }
        tokio::task::spawn_blocking(move || {
            let mut args = vec!["commit", "-F", "-"];
            if amend {
                args.push("--amend");
            }
            git_with_stdin(
                &repo,
                &args,
                msg.as_bytes(),
                PromptPolicy::SilentRead,
                COMMIT_TIMEOUT,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn branches(&self, root: &str) -> Result<Vec<VcsBranch>, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        if !has_head(&repo)? {
            return Ok(vec![]);
        }
        let wt_raw = git(
            &repo,
            &["worktree", "list", "--porcelain"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )
        .unwrap_or_default();
        let mut branch_to_wt: HashMap<String, String> = HashMap::new();
        let mut current_wt: Option<String> = None;
        for line in wt_raw.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                current_wt = Some(display_path(Path::new(p.trim())));
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                if let Some(ref wt) = current_wt {
                    branch_to_wt.insert(b.trim().to_string(), wt.clone());
                }
            } else if line.trim().is_empty() {
                current_wt = None;
            }
        }

        let fmt = "%(HEAD)%09%(refname)%09%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(objectname:short=8)%09%(contents:subject)";
        let raw = git(
            &repo,
            &["for-each-ref", &format!("--format={fmt}"), "refs/heads", "refs/remotes"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let mut list = Vec::new();
        for line in raw.lines() {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 7 {
                continue;
            }
            let full_name = cols[1].to_string();
            let short = cols[2].to_string();
            if full_name.ends_with("/HEAD") {
                continue;
            }
            let is_remote = full_name.starts_with("refs/remotes/");
            let remote = if is_remote {
                short.split('/').next().map(str::to_string)
            } else {
                None
            };
            let track = cols[4];
            let mut ahead = 0u32;
            let mut behind = 0u32;
            for part in track.split(',') {
                let p = part.trim();
                if let Some(n) = p.strip_prefix("ahead ") {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = p.strip_prefix("behind ") {
                    behind = n.parse().unwrap_or(0);
                }
            }
            let wt_path = if !is_remote {
                branch_to_wt.get(&short).cloned()
            } else {
                None
            };
            list.push(VcsBranch {
                name: short.clone(),
                full_name,
                remote,
                is_current: cols[0].trim() == "*",
                is_remote,
                upstream: (!cols[3].is_empty()).then(|| cols[3].to_string()),
                ahead,
                behind,
                commit_oid: cols[5].to_string(),
                subject: cols[6].to_string(),
                worktree_path: wt_path,
            });
        }
        Ok(list)
    }

    pub async fn checkout(&self, root: &str, target: String) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let branch = target.trim().to_string();
        if branch.is_empty() {
            return Err("目标分支不能为空".into());
        }
        tokio::task::spawn_blocking(move || {
            git(&repo, &["checkout", &branch], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn create_branch(
        &self,
        root: &str,
        name: String,
        start_point: Option<String>,
        checkout: bool,
    ) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let branch = name.trim().to_string();
        if branch.is_empty() {
            return Err("新分支名称不能为空".into());
        }
        tokio::task::spawn_blocking(move || {
            let mut args = if checkout {
                vec!["checkout", "-b", &branch]
            } else {
                vec!["branch", &branch]
            };
            let sp = start_point.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if let Some(s) = sp {
                args.push(s);
            }
            git(&repo, &args, PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn delete_branch(
        &self,
        root: &str,
        name: String,
        force: bool,
        delete_remote: bool,
    ) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let branch = name.trim().to_string();
        tokio::task::spawn_blocking(move || {
            if delete_remote {
                if let Some((remote, rbranch)) = branch.split_once('/') {
                    git(
                        &repo,
                        &["push", remote, "--delete", rbranch],
                        PromptPolicy::InteractiveRemote,
                        REMOTE_TIMEOUT,
                    )?;
                    return Ok::<(), String>(());
                }
            }
            let flag = if force { "-D" } else { "-d" };
            git(&repo, &["branch", flag, &branch], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn merge(&self, root: &str, source: String) -> Result<String, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            git(&repo, &["merge", source.trim()], PromptPolicy::SilentRead, WRITE_TIMEOUT)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn rebase(&self, root: &str, upstream: String) -> Result<String, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            git(&repo, &["rebase", upstream.trim()], PromptPolicy::SilentRead, WRITE_TIMEOUT)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn cherry_pick(&self, root: &str, hash: String) -> Result<String, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            git(&repo, &["cherry-pick", hash.trim()], PromptPolicy::SilentRead, WRITE_TIMEOUT)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn revert_commit(&self, root: &str, hash: String) -> Result<String, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            git(
                &repo,
                &["revert", "--no-edit", hash.trim()],
                PromptPolicy::SilentRead,
                WRITE_TIMEOUT,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn continue_or_abort(&self, root: &str, abort: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let git_dir = PathBuf::from(&ctx.git_dir);
        let action = if abort { "--abort" } else { "--continue" };
        let cmd_name = if git_dir.join("MERGE_HEAD").exists() {
            "merge"
        } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            "rebase"
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            "cherry-pick"
        } else if git_dir.join("REVERT_HEAD").exists() {
            "revert"
        } else {
            return Err("当前仓库没有进行中的合并或变基操作".into());
        };
        tokio::task::spawn_blocking(move || {
            let mut cmd = command(&repo, &[cmd_name, action], PromptPolicy::SilentRead, false);
            if !abort {
                cmd.env("GIT_EDITOR", "true");
            }
            let (ok, _, err) = run_raw(cmd, None, WRITE_TIMEOUT)?;
            if ok {
                Ok::<(), String>(())
            } else {
                Err(classify_error(&err).to_wire())
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn conflict_versions(&self, root: &str, rel_path: &str) -> Result<VcsConflictVersions, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let rel = validate_rel_path(rel_path)?;
        let stage_text = |stage: u8| -> String {
            git_bytes(
                &repo,
                &["show", &format!(":{stage}:{rel}")],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )
            .map(|b| format_bytes_capped(&b).0)
            .unwrap_or_default()
        };
        let working = std::fs::read_to_string(repo.join(&rel)).unwrap_or_default();
        let base = stage_text(1);
        let ours = stage_text(2);
        let theirs = stage_text(3);
        Ok(VcsConflictVersions {
            path: rel,
            base,
            ours,
            theirs,
            working,
            ours_label: "当前分支 (Ours)".into(),
            theirs_label: "引入更改 (Theirs)".into(),
        })
    }

    pub async fn resolve_conflict(
        &self,
        root: &str,
        rel_path: &str,
        strategy: String,
        content: Option<String>,
    ) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let rel = validate_rel_path(rel_path)?;
        tokio::task::spawn_blocking(move || {
            match strategy.as_str() {
                "ours" => {
                    git(&repo, &["checkout", "--ours", "--", &rel], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
                }
                "theirs" => {
                    git(&repo, &["checkout", "--theirs", "--", &rel], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
                }
                "custom" => {
                    let body = content.ok_or("缺少解决后的文件内容")?;
                    std::fs::write(repo.join(&rel), body).map_err(|e| e.to_string())?;
                }
                _ => return Err("未知的冲突解决策略".into()),
            }
            git(&repo, &["add", "--", &rel], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn stash_list(&self, root: &str) -> Result<Vec<VcsStashEntry>, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let out = git(
            &repo,
            &["stash", "list", "--date=relative", "--format=%gd%x09%gs%x09%cr"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )
        .unwrap_or_default();
        let entries = out
            .lines()
            .enumerate()
            .filter_map(|(idx, line)| {
                let cols: Vec<&str> = line.split('\t').collect();
                if cols.len() < 3 {
                    return None;
                }
                let subject = cols[1].trim();
                let branch = subject
                    .strip_prefix("WIP on ")
                    .or_else(|| subject.strip_prefix("On "))
                    .and_then(|s| s.split(':').next())
                    .map(str::trim)
                    .map(str::to_string);
                Some(VcsStashEntry {
                    index: idx,
                    ref_name: cols[0].trim().to_string(),
                    message: subject.to_string(),
                    branch,
                    date_display: cols[2].trim().to_string(),
                })
            })
            .collect();
        Ok(entries)
    }

    pub async fn stash_push(
        &self,
        root: &str,
        message: Option<String>,
        include_untracked: bool,
    ) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            let mut args = vec!["stash", "push"];
            if include_untracked {
                args.push("-u");
            }
            let msg = message.unwrap_or_default();
            if !msg.trim().is_empty() {
                args.push("-m");
                args.push(msg.trim());
            }
            git(&repo, &args, PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn stash_apply(&self, root: &str, index: usize, pop: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let ref_name = format!("stash@{{{index}}}");
        tokio::task::spawn_blocking(move || {
            let op = if pop { "pop" } else { "apply" };
            git(&repo, &["stash", op, &ref_name], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn stash_drop(&self, root: &str, index: usize) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let ref_name = format!("stash@{{{index}}}");
        tokio::task::spawn_blocking(move || {
            git(&repo, &["stash", "drop", &ref_name], PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn worktree_list(
        &self,
        root: &str,
        sessions: &[(String, String)],
        workspace_cwds: &HashMap<String, String>,
    ) -> Result<Vec<VcsWorktree>, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let raw = git(
            &repo,
            &["worktree", "list", "--porcelain"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let mut by_wt: HashMap<String, Vec<String>> = HashMap::new();
        for (sid, wid) in sessions {
            if let Some(cwd) = workspace_cwds.get(wid) {
                let key = path_key(Path::new(cwd));
                by_wt.entry(key).or_default().push(sid.clone());
            }
        }

        let mut list = Vec::new();
        let mut current: Option<VcsWorktree> = None;
        for line in raw.lines().chain(std::iter::once("")) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if let Some(mut wt) = current.take() {
                    let key = path_key(Path::new(&wt.path));
                    wt.session_ids = by_wt.get(&key).cloned().unwrap_or_default();
                    list.push(wt);
                }
                continue;
            }
            if let Some(p) = trimmed.strip_prefix("worktree ") {
                let path = display_path(Path::new(p.trim()));
                current = Some(VcsWorktree {
                    path,
                    head_oid: String::new(),
                    branch: None,
                    is_main: list.is_empty(),
                    is_locked: false,
                    lock_reason: None,
                    prunable: false,
                    session_ids: vec![],
                });
            } else if let Some(ref mut wt) = current {
                if let Some(head) = trimmed.strip_prefix("HEAD ") {
                    wt.head_oid = head.chars().take(12).collect();
                } else if let Some(b) = trimmed.strip_prefix("branch ") {
                    wt.branch = Some(
                        b.trim()
                            .strip_prefix("refs/heads/")
                            .unwrap_or(b.trim())
                            .to_string(),
                    );
                } else if let Some(rest) = trimmed.strip_prefix("locked") {
                    wt.is_locked = true;
                    let r = rest.trim();
                    if !r.is_empty() {
                        wt.lock_reason = Some(r.to_string());
                    }
                } else if trimmed.starts_with("prunable") {
                    wt.prunable = true;
                }
            }
        }
        Ok(list)
    }

    pub async fn worktree_add(
        &self,
        root: &str,
        branch: String,
        create_branch: bool,
        start_point: Option<String>,
        reason: Option<String>,
    ) -> Result<VcsWorktree, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let main_root = PathBuf::from(&ctx.common_git_dir)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| repo.clone());
        let parent_dir = main_root.parent().unwrap_or(&main_root).to_path_buf();
        let slug = slugify_branch_segment(&branch);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() % 10000)
            .unwrap_or(0);
        let wt_container = parent_dir.join(".codev-worktrees");
        let target_dir = wt_container.join(format!("{}-{}-{}", slugify_branch_segment(&ctx.repo_name), slug, stamp));
        let branch_clean = branch.trim().to_string();
        if branch_clean.is_empty() {
            return Err("Worktree 分支名不能为空".into());
        }
        let reason_text = reason
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| format!("Codev worktree for {branch_clean}"));

        let created_path = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&wt_container).map_err(|e| e.to_string())?;
            let target_str = target_dir.to_string_lossy().into_owned();
            let mut args: Vec<String> = vec![
                "worktree".into(),
                "add".into(),
                "--lock".into(),
                "--reason".into(),
                reason_text,
            ];
            if create_branch {
                args.push("-b".into());
                args.push(branch_clean.clone());
            }
            args.push(target_str.clone());
            if create_branch {
                if let Some(sp) = start_point.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    args.push(sp.into());
                }
            } else {
                args.push(branch_clean.clone());
            }
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(err) = git(&repo, &refs, PromptPolicy::SilentRead, WRITE_TIMEOUT) {
                let _ = std::fs::remove_dir_all(&target_dir);
                return Err(err);
            }
            Ok::<PathBuf, String>(target_dir)
        })
        .await
        .map_err(|e| e.to_string())??;

        let new_snap = self.snapshot(&display_path(&created_path))?.ok_or("Worktree 创建后读取失败")?;
        Ok(VcsWorktree {
            path: new_snap.worktree_root,
            head_oid: new_snap.head_oid,
            branch: Some(new_snap.branch),
            is_main: false,
            is_locked: true,
            lock_reason: None,
            prunable: false,
            session_ids: vec![],
        })
    }

    pub async fn worktree_remove(&self, root: &str, wt_path: String, force: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        let wt_canon = display_path(&canon_path(Path::new(&wt_path))?);
        if path_key(Path::new(&wt_canon)) == path_key(Path::new(&ctx.worktree_root))
            && !ctx.is_worktree
        {
            return Err("不能移除主工作树".into());
        }
        tokio::task::spawn_blocking(move || {
            let _ = git(&repo, &["worktree", "unlock", &wt_canon], PromptPolicy::SilentRead, READ_TIMEOUT);
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.push(&wt_canon);
            git(&repo, &args, PromptPolicy::SilentRead, WRITE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn log(
        &self,
        root: &str,
        all_branches: bool,
        limit: usize,
        search: Option<String>,
    ) -> Result<Vec<VcsCommit>, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        if !has_head(&repo)? {
            return Ok(vec![]);
        }
        let head_branch = git(
            &repo,
            &["branch", "--show-current"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

        let bounded = limit.clamp(10, 400).to_string();
        let mut args = vec![
            "log".to_string(),
            "-n".into(),
            bounded,
            "--date=relative".into(),
            "--topo-order".into(),
            "--format=%x1e%H%x1f%h%x1f%P%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%cr%x1f%D".into(),
        ];
        if all_branches {
            args.push("--all".into());
        }
        if let Some(q) = search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push(format!("--grep={q}"));
            args.push("--regexp-ignore-case".into());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = git(&repo, &refs, PromptPolicy::SilentRead, READ_TIMEOUT)?;
        let mut commits = Vec::new();
        for record in raw.split('\x1e').filter(|r| !r.trim().is_empty()) {
            let cols: Vec<&str> = record.split('\x1f').collect();
            if cols.len() < 10 {
                continue;
            }
            let hash = cols[0].trim().to_string();
            let short_hash = cols[1].trim().to_string();
            let parents: Vec<String> = cols[2]
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let subject = cols[3].trim().to_string();
            let body = cols[4].trim().to_string();
            let author = cols[5].trim().to_string();
            let email = cols[6].trim().to_string();
            let timestamp = cols[7].trim().parse::<i64>().unwrap_or(0);
            let date_display = cols[8].trim().to_string();
            let refs_badges = parse_ref_badges(cols[9].trim(), &head_branch);
            commits.push(VcsCommit {
                hash,
                short_hash,
                parents,
                subject,
                body,
                author,
                email,
                timestamp,
                date_display,
                refs: refs_badges,
            });
        }
        Ok(commits)
    }

    pub fn commit_detail(&self, root: &str, hash: &str) -> Result<VcsCommitDetail, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let head_branch = git(
            &repo,
            &["branch", "--show-current"],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
        let raw_meta = git(
            &repo,
            &[
                "show",
                "-s",
                "--date=relative",
                "--format=%H%x1f%h%x1f%P%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%cr%x1f%D",
                hash.trim(),
            ],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let cols: Vec<&str> = raw_meta.split('\x1f').collect();
        if cols.len() < 10 {
            return Err("无法解析提交信息".into());
        }
        let commit = VcsCommit {
            hash: cols[0].trim().to_string(),
            short_hash: cols[1].trim().to_string(),
            parents: cols[2].split_whitespace().map(str::to_string).collect(),
            subject: cols[3].trim().to_string(),
            body: cols[4].trim().to_string(),
            author: cols[5].trim().to_string(),
            email: cols[6].trim().to_string(),
            timestamp: cols[7].trim().parse::<i64>().unwrap_or(0),
            date_display: cols[8].trim().to_string(),
            refs: parse_ref_badges(cols[9].trim(), &head_branch),
        };
        let stat_raw = git(
            &repo,
            &["show", "--numstat", "--format=", hash.trim()],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let ns_raw = git(
            &repo,
            &["show", "--name-status", "--format=", hash.trim()],
            PromptPolicy::SilentRead,
            READ_TIMEOUT,
        )?;
        let mut status_map: HashMap<String, (String, Option<String>)> = HashMap::new();
        for line in ns_raw.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 && (parts[0].starts_with('R') || parts[0].starts_with('C')) {
                status_map.insert(
                    parts[2].to_string(),
                    (parts[0][..1].to_string(), Some(parts[1].to_string())),
                );
            } else if parts.len() >= 2 {
                status_map.insert(parts[1].to_string(), (parts[0].to_string(), None));
            }
        }
        let mut files = Vec::new();
        for line in stat_raw.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let additions = parts[0].parse::<u32>().unwrap_or(0);
            let deletions = parts[1].parse::<u32>().unwrap_or(0);
            let path = parts[2].to_string();
            let (status, old_path) = status_map
                .get(&path)
                .cloned()
                .unwrap_or_else(|| ("M".into(), None));
            files.push(VcsCommitFile {
                path,
                status,
                old_path,
                additions,
                deletions,
            });
        }
        Ok(VcsCommitDetail { commit, files })
    }

    pub fn commit_file_diff(&self, root: &str, hash: &str, rel_path: &str) -> Result<VcsDiffPayload, String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let repo = PathBuf::from(&ctx.worktree_root);
        let rel = validate_rel_path(rel_path)?;
        let parent_spec = format!("{}^:{rel}", hash.trim());
        let cur_spec = format!("{}:{rel}", hash.trim());
        let orig_bytes = git_bytes(&repo, &["show", &parent_spec], PromptPolicy::SilentRead, READ_TIMEOUT)
            .unwrap_or_default();
        let mod_bytes = git_bytes(&repo, &["show", &cur_spec], PromptPolicy::SilentRead, READ_TIMEOUT)
            .unwrap_or_default();
        let (original, to, bo) = format_bytes_capped(&orig_bytes);
        let (modified, tm, bm) = format_bytes_capped(&mod_bytes);
        let unified = if bo || bm {
            String::new()
        } else {
            git(
                &repo,
                &["show", "--format=", hash.trim(), "--", &rel],
                PromptPolicy::SilentRead,
                READ_TIMEOUT,
            )
            .unwrap_or_default()
        };
        Ok(VcsDiffPayload {
            path: rel,
            original_label: format!("{}^", &hash.trim().chars().take(7).collect::<String>()),
            modified_label: hash.trim().chars().take(7).collect(),
            original,
            modified,
            unified,
            truncated: to || tm,
            binary: bo || bm,
        })
    }

    pub async fn fetch(&self, root: &str, prune: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            let mut args = vec!["fetch", "--no-recurse-submodules"];
            if prune {
                args.push("--prune");
            }
            git(&repo, &args, PromptPolicy::InteractiveRemote, REMOTE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn pull(&self, root: &str, rebase: Option<bool>) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            let args: Vec<&str> = match rebase {
                Some(true) => vec!["pull", "--rebase", "--no-recurse-submodules"],
                Some(false) => vec!["pull", "--ff-only", "--no-recurse-submodules"],
                None => vec!["pull", "--no-recurse-submodules"],
            };
            git(&repo, &args, PromptPolicy::InteractiveRemote, REMOTE_TIMEOUT)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn push(&self, root: &str, set_upstream: bool) -> Result<(), String> {
        let ctx = ensure_repo_context(Path::new(root))?;
        let slot = self.write_slot(&ctx.common_git_dir);
        let _guard = slot.lock().await;
        let repo = PathBuf::from(&ctx.worktree_root);
        tokio::task::spawn_blocking(move || {
            if set_upstream {
                let branch = git(
                    &repo,
                    &["symbolic-ref", "--short", "-q", "HEAD"],
                    PromptPolicy::SilentRead,
                    READ_TIMEOUT,
                )?;
                let b = branch.trim();
                if b.is_empty() {
                    return Err(VcsError::new(
                        VcsErrorCode::DetachedHead,
                        "当前处于游离 HEAD 状态，无法自动关联上游推送",
                        "请先基于当前提交创建一个本地分支后再推送。",
                    )
                    .to_wire());
                }
                git(
                    &repo,
                    &["push", "-u", "origin", b, "--recurse-submodules=no"],
                    PromptPolicy::InteractiveRemote,
                    REMOTE_TIMEOUT,
                )?;
            } else {
                git(
                    &repo,
                    &["push", "--recurse-submodules=no"],
                    PromptPolicy::InteractiveRemote,
                    REMOTE_TIMEOUT,
                )?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn init_repo(&self, root: &str, default_branch: Option<String>) -> Result<VcsSnapshot, String> {
        let target = canon_path(Path::new(root))?;
        if !target.is_dir() {
            return Err("目标目录不存在".into());
        }
        let branch = default_branch
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("main")
            .to_string();
        let target_clone = target.clone();
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(git_binary());
            cmd.current_dir(&target_clone)
                .args(["init", "-b", &branch]);
            crate::modules::proc::hide_console(&mut cmd);
            let (ok, _, err) = run_raw(cmd, None, WRITE_TIMEOUT)?;
            if ok {
                Ok::<(), String>(())
            } else {
                Err(classify_error(&err).to_wire())
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        self.snapshot(&display_path(&target))?.ok_or_else(|| "初始化 Git 仓库失败".into())
    }

    pub fn doctor_check(&self, root: Option<&str>) -> Result<VcsDoctorReport, String> {
        let mut ver_cmd = std::process::Command::new(git_binary());
        ver_cmd.arg("--version");
        crate::modules::proc::hide_console(&mut ver_cmd);
        let (git_installed, ver_out) = match run_raw(ver_cmd, None, Duration::from_secs(4)) {
            Ok((ok, out, _)) if ok => (true, Some(String::from_utf8_lossy(&out).trim().to_string())),
            _ => (false, None),
        };
        let repo_ctx = root
            .and_then(|r| resolve_repo_context(Path::new(r)).ok().flatten());
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
        let gh_installed = run_raw(gh_ver, None, Duration::from_secs(3))
            .is_ok_and(|(ok, _, _)| ok);
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
        if cfg!(windows) && autocrlf.as_deref() != Some("input") && autocrlf.as_deref() != Some("false") {
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
                detail: "如使用 GitHub 收件箱同步 Issue/PR，可登录 `gh auth login` 或配置 PAT。".into(),
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
        if let Some(email) = user_email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
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
        Ok(())
    }

    pub fn capture_turn_baseline(&self, session_id: &str, turn_id: &str, cwd: &str) {
        let Ok(Some(snap)) = self.snapshot(cwd) else {
            return;
        };
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

    pub fn compute_turn_diff(&self, session_id: &str, cwd: &str) -> Option<VcsTurnDiffSummary> {
        let baseline = self.turn_baselines.lock().unwrap().get(session_id)?.clone();
        let snap = self.snapshot(cwd).ok().flatten()?;
        if snap.worktree_root != baseline.worktree_root {
            return None;
        }
        let repo = PathBuf::from(&snap.worktree_root);
        let mut changed_files = Vec::new();
        for entry in &snap.entries {
            let sig = format!("{}{}", entry.index_status, entry.worktree_status);
            let existed_same = baseline.dirty_paths.get(&entry.path) == Some(&sig);
            if !existed_same {
                changed_files.push(VcsTurnFileSummary {
                    path: entry.path.clone(),
                    status: sig,
                    staged: entry.staged,
                    untracked: entry.untracked,
                });
            }
        }
        let mut new_commits = 0usize;
        if !baseline.head_oid.is_empty() && !snap.head_oid.is_empty() && baseline.head_oid != snap.head_oid {
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
                let existing: HashSet<String> = changed_files.iter().map(|f| f.path.clone()).collect();
                for line in committed.lines() {
                    let parts: Vec<&str> = line.split('\t').collect();
                    if parts.len() >= 2 {
                        let path = parts.last().unwrap().to_string();
                        if !existing.contains(&path) {
                            changed_files.push(VcsTurnFileSummary {
                                path,
                                status: parts[0].chars().take(2).collect(),
                                staged: false,
                                untracked: false,
                            });
                        }
                    }
                }
            }
        }
        Some(VcsTurnDiffSummary {
            turn_id: baseline.turn_id,
            worktree_root: snap.worktree_root,
            branch: snap.branch,
            base_head_oid: baseline.head_oid,
            head_oid: snap.head_oid,
            changed_files,
            new_commits,
            dirty_before: baseline.dirty_before,
            dirty_after: snap.entries.len(),
        })
    }

    pub async fn revert_turn_changes(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        let Some(summary) = self.compute_turn_diff(session_id, cwd) else {
            return Err("未找到本轮基线记录，无法自动撤销".into());
        };
        if summary.new_commits > 0 {
            return Err("本轮期间产生了新提交，请在 Git 历史面板中使用 Revert 安全回滚。".into());
        }
        let paths: Vec<String> = summary.changed_files.into_iter().map(|f| f.path).collect();
        if paths.is_empty() {
            return Ok(());
        }
        self.discard_files(&summary.worktree_root, paths).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn run_ok(cwd: &Path, args: &[&str]) {
        let out = git(cwd, args, PromptPolicy::SilentRead, Duration::from_secs(10));
        assert!(out.is_ok(), "git {:?} failed: {:?}", args, out);
    }

    fn init_sample_repo() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let root = dir.path();
        run_ok(root, &["init", "-b", "main"]);
        run_ok(root, &["config", "user.name", "Codev Tester"]);
        run_ok(root, &["config", "user.email", "tester@codev.local"]);
        std::fs::write(root.join("README.md"), "hello\n").unwrap();
        run_ok(root, &["add", "README.md"]);
        run_ok(root, &["commit", "-m", "init"]);
        dir
    }

    #[tokio::test]
    async fn snapshot_stage_commit_and_log_roundtrip() {
        let dir = init_sample_repo();
        let root = dir.path().to_string_lossy().into_owned();
        let svc = VcsService::default();

        std::fs::write(dir.path().join("README.md"), "hello world\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new line\n").unwrap();

        let snap = svc.snapshot(&root).unwrap().unwrap();
        assert_eq!(snap.branch, "main");
        assert_eq!(snap.counts.modified, 1);
        assert_eq!(snap.counts.untracked, 1);

        let diff = svc.diff(&root, "README.md", false).unwrap();
        assert_eq!(diff.original, "hello\n");
        assert_eq!(diff.modified, "hello world\n");

        svc.stage(&root, vec!["README.md".into(), "new.txt".into()], true)
            .await
            .unwrap();
        let staged_snap = svc.snapshot(&root).unwrap().unwrap();
        assert_eq!(staged_snap.counts.staged, 2);

        svc.commit(&root, "feat: add new file".into(), false)
            .await
            .unwrap();
        let commits = svc.log(&root, false, 10, None).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "feat: add new file");
        assert_eq!(commits[0].parents.len(), 1);
    }

    #[tokio::test]
    async fn worktree_resolves_to_common_git_dir_and_turn_baseline() {
        let dir = init_sample_repo();
        let root = dir.path().to_string_lossy().into_owned();
        let svc = VcsService::default();

        let wt = svc
            .worktree_add(&root, "feat/wt-test".into(), true, None, Some("unit test".into()))
            .await
            .unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feat/wt-test"));
        assert!(wt.is_locked);

        let wt_ctx = resolve_repo_context(Path::new(&wt.path)).unwrap().unwrap();
        let main_ctx = resolve_repo_context(Path::new(&root)).unwrap().unwrap();
        assert!(wt_ctx.is_worktree);
        assert_eq!(wt_ctx.common_git_dir, main_ctx.common_git_dir);

        svc.capture_turn_baseline("sess-1", "turn-1", &wt.path);
        std::fs::write(Path::new(&wt.path).join("README.md"), "wt change\n").unwrap();
        let summary = svc.compute_turn_diff("sess-1", &wt.path).unwrap();
        assert_eq!(summary.changed_files.len(), 1);
        assert_eq!(summary.changed_files[0].path, "README.md");

        svc.worktree_remove(&root, wt.path, true).await.unwrap();
    }

    #[test]
    fn reject_path_traversal_outside_repo() {
        let err = validate_rel_path("../secret.txt").unwrap_err();
        assert!(err.contains("非法"));
    }
}
