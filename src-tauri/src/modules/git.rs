#[path = "git/process.rs"]
mod process;

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepo { pub root: String, pub name: String, pub branch: String, pub changes: usize }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange { pub path: String, pub status: String, pub staged: bool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit { pub hash: String, pub subject: String, pub author: String, pub date: String, pub refs: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTracking { pub branch: String, pub upstream: String, pub ahead: u32, pub behind: u32 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot { pub repo: GitRepo, pub changes: Vec<GitChange>, pub empty: bool }

static WRITING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
struct WriteGuard(PathBuf);
impl Drop for WriteGuard {
    /// 结束操作后释放同一仓库的写锁。
    fn drop(&mut self) { if let Ok(mut roots) = WRITING.lock() { roots.remove(&self.0); } }
}
/// 同一仓库禁止并行提交、暂存及远程写操作。
fn write_guard(root: &Path) -> Result<WriteGuard, String> {
    let path = root.canonicalize().map_err(|e| e.to_string())?;
    if !WRITING.lock().map_err(|e| e.to_string())?.insert(path.clone()) { return Err("该仓库已有 Git 操作进行中".into()); }
    Ok(WriteGuard(path))
}
/// 本地读取统一设定短超时，不允许 pager、外部 diff 或交互认证。
fn git(repo: &Path, args: &[&str]) -> Result<String, String> { process::git(repo, args, Duration::from_secs(5)) }

/// 路径必须为仓库相对文件名，禁止路径越界及 pathspec 魔法。
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || Path::new(path).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("文件路径必须位于当前仓库内".into());
    }
    Ok(())
}
/// NUL 分隔读取状态，保留空格、引号、重命名和同时暂存/未暂存的两个状态。
fn parse_changes(text: &str) -> Vec<GitChange> {
    let mut records = text.split('\0');
    let mut result = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 { continue; }
        let code = record.as_bytes();
        let path = record[3..].to_string();
        if code[0] == b'R' || code[0] == b'C' || code[1] == b'R' || code[1] == b'C' { records.next(); }
        if code[0] != b' ' && code[0] != b'?' { result.push(GitChange { path: path.clone(), status: (code[0] as char).to_string(), staged: true }); }
        if code[1] != b' ' { result.push(GitChange { path, status: (code[1] as char).to_string(), staged: false }); }
    }
    result
}
/// 只读取工作区根目录本身，不向下发现子仓库。
#[tauri::command]
pub async fn git_snapshot(root: String) -> Result<Option<GitSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || read_snapshot(&root)).await.map_err(|e| e.to_string())?
}

fn read_snapshot(root: &str) -> Result<Option<GitSnapshot>, String> {
    let path = PathBuf::from(root);
    if !path.is_dir() { return Err("工作区目录不可访问".into()); }
    if !path.join(".git").exists() { return Ok(None); }
    let branch = git(&path, &["branch", "--show-current"])?;
    let changes = parse_changes(&git(&path, &["status", "--porcelain=v1", "-z"])?);
    let empty = !process::has_head(&path)? && changes.is_empty();
    let repo = GitRepo { root: root.into(), name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), branch: if branch.trim().is_empty() { "HEAD".into() } else { branch.trim().into() }, changes: changes.iter().map(|c| &c.path).collect::<HashSet<_>>().len() };
    Ok(Some(GitSnapshot { repo, changes, empty }))
}
/// 查看差异不运行仓库配置中的外部 diff/textconv。
#[tauri::command]
pub async fn git_diff(root: String, path: String, staged: bool) -> Result<String, String> {
    validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
        if staged { args.push("--cached"); }
        args.extend(["--", &path]);
        git(&PathBuf::from(root), &args)
    }).await.map_err(|e| e.to_string())?
}
/// 显式点击才暂存或取消暂存，不重置工作区文件。
#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, staged: bool) -> Result<(), String> {
    if paths.is_empty() { return Err("请先选择文件".into()); }
    for path in &paths { validate_path(path)?; }
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let _guard = write_guard(&repo)?;
        let mut args = if staged { vec!["add"] } else { vec!["restore", "--staged"] };
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        process::git(&repo, &args, Duration::from_secs(30)).map(|_| ())
    }).await.map_err(|e| e.to_string())?
}
/// 提交图仅查看本地已知历史，不附带联网 fetch，也不校验提交签名。
#[tauri::command]
pub async fn git_log(root: String) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = process::git(&PathBuf::from(root), &["log", "--no-show-signature", "--all", "--decorate", "-120", "--pretty=format:%h%x1f%s%x1f%an%x1f%ad%x1f%D", "--date=short"], Duration::from_secs(20))?;
        Ok(text.lines().filter_map(|line| { let mut parts = line.split('\u{1f}'); Some(GitCommit { hash: parts.next()?.into(), subject: parts.next()?.into(), author: parts.next()?.into(), date: parts.next()?.into(), refs: parts.next().unwrap_or_default().into() }) }).collect())
    }).await.map_err(|e| e.to_string())?
}
/// 上游及领先落后数量只读本地引用，不访问远程服务器。
#[tauri::command]
pub async fn git_tracking(root: String) -> Result<GitTracking, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let branch = git(&repo, &["branch", "--show-current"] )?.trim().to_string();
        let upstream = if branch.is_empty() { String::new() } else { git(&repo, &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")])?.trim().to_string() };
        let counts = if upstream.is_empty() { String::new() } else { git(&repo, &["rev-list", "--left-right", "--count", &format!("HEAD...{upstream}")])? };
        let mut parts = counts.split_whitespace();
        Ok(GitTracking { branch, upstream, ahead: parts.next().unwrap_or("0").parse().unwrap_or(0), behind: parts.next().unwrap_or("0").parse().unwrap_or(0) })
    }).await.map_err(|e| e.to_string())?
}
/// 远程操作只由用户发起，使用短连接超时和整体进程超时。
async fn remote(root: String, args: Vec<&'static str>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let _guard = write_guard(&repo)?;
        let mut options = vec!["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=15", "-c", "protocol.ext.allow=never"];
        options.extend(args);
        process::git(&repo, &options, Duration::from_secs(60)).map(|_| ())
    }).await.map_err(|e| e.to_string())?
}
/// 只获取当前默认远程，不遍历所有远程、不自动删除引用。
#[tauri::command]
pub async fn git_fetch(root: String) -> Result<(), String> { remote(root, vec!["fetch", "--no-recurse-submodules"]).await }
/// 保持仅快进拉取，禁止递归联网子模块。
#[tauri::command]
pub async fn git_pull(root: String) -> Result<(), String> { remote(root, vec!["pull", "--ff-only", "--no-recurse-submodules"]).await }
/// 显式推送，沿用 Git 原生上游配置，不强推。
#[tauri::command]
pub async fn git_push(root: String) -> Result<(), String> { remote(root, vec!["push", "--recurse-submodules=no"]).await }
/// 提交遵守用户 hooks/签名设置，失败或超时不会自动重试。
#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() { return Err("请填写提交说明".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(root);
        let _guard = write_guard(&repo)?;
        process::git(&repo, &["commit", "-m", &message], Duration::from_secs(60)).map(|_| ())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_only_root_and_filters_empty_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.path().join("nested/.git")).unwrap();
        assert!(read_snapshot(&root).unwrap().is_none());
        git(dir.path(), &["init"]).unwrap();
        assert!(read_snapshot(&root).unwrap().unwrap().empty);
        std::fs::write(dir.path().join("first.txt"), "first").unwrap();
        let state = read_snapshot(&root).unwrap().unwrap();
        assert!(!state.empty);
        assert_eq!(state.changes.len(), 1);
    }

    /// 空格、重命名来源和双重状态不能产生错误暂存路径。
    #[test]
    fn parses_nul_status() {
        let rows = parse_changes("MM a file.txt\0R  new name\0old name\0?? \"file\".txt\0");
        assert_eq!(rows.len(), 4);
        assert!(rows[0].staged);
        assert!(!rows[1].staged);
        assert_eq!(rows[2].path, "new name");
        assert_eq!(rows[3].path, "\"file\".txt");
        assert!(validate_path("../outside").is_err());
    }
}
