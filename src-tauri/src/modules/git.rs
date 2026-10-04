use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", ".next", ".venv", "venv", "__pycache__",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepo {
    pub root: String,
    pub name: String,
    pub branch: String,
    pub changes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTracking {
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub repo: GitRepo,
    pub changes: Vec<GitChange>,
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(repo).args(args).output().map_err(|error| format!("无法启动 Git：{error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() { format!("Git 命令失败：{}", args.join(" ")) } else { detail })
}

fn repo_root(path: &Path) -> Option<PathBuf> {
    git(path, &["rev-parse", "--show-toplevel"]).ok().map(PathBuf::from)
}

fn repo_info(root: &Path) -> Result<GitRepo, String> {
    let branch = git(root, &["branch", "--show-current"]).unwrap_or_else(|_| "HEAD".into());
    let status = git(root, &["status", "--porcelain"])?;
    let changes = status.lines().filter(|line| !line.trim().is_empty()).count();
    Ok(GitRepo {
        root: root.display().to_string(),
        name: root.file_name().and_then(|name| name.to_str()).unwrap_or("Git").to_string(),
        branch: if branch.is_empty() { "HEAD".into() } else { branch },
        changes,
    })
}

fn visit(path: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if depth > 5 || found.len() >= 200 { return; }
    if repo_root(path).as_deref() == Some(path) {
        found.push(path.to_path_buf());
        return;
    }
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let next = entry.path();
        if !next.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') { continue; }
        visit(&next, depth + 1, found);
    }
}

#[tauri::command]
pub async fn git_discover(roots: Vec<String>) -> Result<Vec<GitRepo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        for root in roots {
            let path = PathBuf::from(root);
            if path.is_dir() { visit(&path, 0, &mut found); }
        }
        found.sort();
        found.dedup();
        found.iter().map(|root| repo_info(root)).collect()
    }).await.map_err(|error| error.to_string())?
}

fn changes(root: &Path) -> Result<Vec<GitChange>, String> {
    let text = git(root, &["status", "--porcelain"])?;
    Ok(text.lines().filter_map(|line| {
        let mut chars = line.chars();
        let staged = chars.next()?;
        let unstaged = chars.next()?;
        let path = line.get(3..)?.trim().trim_matches('"').to_string();
        if path.is_empty() { return None; }
        let status = if staged != ' ' && staged != '?' { staged } else { unstaged };
        Some(GitChange {
            path,
            status: status.to_string(),
            staged: staged != ' ' && staged != '?',
        })
    }).collect())
}

#[tauri::command]
pub async fn git_snapshot(root: String) -> Result<GitSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        Ok(GitSnapshot { repo: repo_info(&path)?, changes: changes(&path)? })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_diff(root: String, path: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        if staged { git(&repo, &["diff", "--cached", "--", &path]) } else { git(&repo, &["diff", "--", &path]) }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, staged: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let mut args = vec![if staged { "add" } else { "restore" }];
        if !staged { args.push("--staged"); }
        args.push("--");
        let owned: Vec<String> = paths;
        for path in &owned { args.push(path); }
        git(&repo, &args).map(|_| ())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_log(root: String) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = git(&PathBuf::from(root), &["log", "--all", "--decorate", "-120", "--pretty=format:%h%x1f%s%x1f%an%x1f%ad%x1f%D", "--date=short"])?;
        Ok(text.lines().filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            Some(GitCommit { hash: parts.next()?.into(), subject: parts.next()?.into(), author: parts.next()?.into(), date: parts.next()?.into(), refs: parts.next().unwrap_or_default().into() })
        }).collect())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_tracking(root: String) -> Result<GitTracking, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let branch = git(&repo, &["branch", "--show-current"]).unwrap_or_default();
        let upstream = git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).unwrap_or_default();
        let counts = if upstream.is_empty() { String::new() } else { git(&repo, &["rev-list", "--left-right", "--count", &format!("HEAD...{upstream}")])? };
        let mut parts = counts.split_whitespace();
        Ok(GitTracking { branch, upstream, ahead: parts.next().unwrap_or("0").parse().unwrap_or(0), behind: parts.next().unwrap_or("0").parse().unwrap_or(0) })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git(&PathBuf::from(root), &["fetch", "--all", "--prune"]).map(|_| ())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git(&PathBuf::from(root), &["pull", "--ff-only"]).map(|_| ())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git(&PathBuf::from(root), &["push"]).map(|_| ())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() { return Err("请填写提交说明".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        git(&PathBuf::from(root), &["commit", "-m", &message]).map(|_| ())
    }).await.map_err(|error| error.to_string())?
}
