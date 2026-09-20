use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use ignore::WalkBuilder;
use serde::Serialize;

use super::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

#[derive(Serialize, Clone)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root; multiple roots include the root name.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True if the scan stopped early (entry budget or hit cap reached).
    pub truncated: bool,
    pub scanned: usize,
    pub unreadable: usize,
    pub scan_incomplete: bool,
    pub matched: usize,
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
const MAX_SCANNED: usize = 200_000;

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
    ".ruff_cache",
    "vendor",
    "artifacts",
    ".reference-cache",
    ".playwright-cli",
    "output",
];

fn keep_search_entry(dent: &ignore::DirEntry) -> bool {
    if dent.depth() == 0 {
        return true;
    }
    dent.file_name()
        .to_str()
        .map(|name| !PRUNE_DIRS.contains(&name))
        .unwrap_or(true)
}

#[tauri::command]
pub fn fs_search(
    roots: Vec<String>,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    search_impl(
        roots,
        query,
        limit,
        workspace,
        Some(show_hidden.unwrap_or(true)),
        true,
        MAX_SCANNED,
        &AtomicBool::new(false),
    )
}

/// 单根搜索请求的取消标志，仅在请求执行期间保留。
#[derive(Default)]
pub struct SearchState {
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// 停止已被新输入替代的搜索。
#[tauri::command]
pub fn fs_search_cancel(state: tauri::State<'_, SearchState>, request_id: String) {
    if let Some(cancel) = state.requests.lock().unwrap().get(&request_id) {
        cancel.store(true, Ordering::Relaxed);
    }
}

/// 后台执行单根搜索，避免阻塞桌面主线程。
#[tauri::command]
pub async fn fs_search_query(
    state: tauri::State<'_, SearchState>,
    request_id: String,
    root: String,
    query: String,
    on_batch: tauri::ipc::Channel<Vec<SearchHit>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<SearchResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .requests
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        search_walk(
            vec![root],
            query,
            Some(200_001),
            workspace,
            Some(true),
            true,
            MAX_SCANNED,
            &cancel,
            Some(&|batch| { let _ = on_batch.send(batch); }),
        )
    })
    .await
    .map_err(|error| error.to_string());
    state.requests.lock().unwrap().remove(&request_id);
    result?
}

/// 有界扫描并保留最佳候选，明确区分扫描截断和展示截断。
fn search_impl(
    roots: Vec<String>,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
    include_generated: bool,
    scan_limit: usize,
    cancel: &AtomicBool,
) -> Result<SearchResult, String> {
    search_walk(roots, query, limit, workspace, show_hidden, include_generated, scan_limit, cancel, None)
}

/// 分批推送命中，超过二十万个文件才停止扫描。
fn search_walk(roots: Vec<String>, query: String, limit: Option<usize>, workspace: Option<WorkspaceEnv>, show_hidden: Option<bool>, include_generated: bool, scan_limit: usize, cancel: &AtomicBool, progress: Option<&dyn Fn(Vec<SearchHit>)>) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
            scanned: 0,
            unreadable: 0,
            scan_incomplete: false,
            matched: 0,
        });
    }
    let cap = if progress.is_some() { usize::MAX } else { limit.unwrap_or(200).min(200_001) };
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_inputs: Vec<String> = roots
        .into_iter()
        .map(|root| root.trim().to_string())
        .filter(|root| !root.is_empty())
        .collect();
    if root_inputs.is_empty() {
        return Err("no search roots".to_string());
    }

    let multi_root = root_inputs.len() > 1;
    let mut resolved_roots = Vec::with_capacity(root_inputs.len());
    for root_display in root_inputs {
        let root_path = resolve_path(&root_display, &workspace);
        if !root_path.is_dir() {
            return Err(format!("not a directory: {root_display}"));
        }
        let root_label = root_display
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|label| !label.is_empty())
            .unwrap_or(root_display.as_str())
            .to_string();
        resolved_roots.push((root_display, root_path, root_label));
    }

    let mut cands: Vec<SearchHit> = Vec::new();
    let mut scanned: usize = 0;
    let mut truncated = false;
    let mut unreadable = 0;
    let mut matched = 0;
    let mut seen_paths = HashSet::new();
    let mut batch = Vec::new();
    let mut published = std::time::Instant::now();

    for (root_display, root_path, root_label) in resolved_roots {
        let walker = WalkBuilder::new(&root_path)
            .hidden(!show_hidden)
            // 包含隐藏及生成目录，不沿符号链接重复遍历。
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(true)
            .follow_links(false)
            .filter_entry(move |entry| include_generated || keep_search_entry(entry))
            .build();

        for dent in walker {
            if cancel.load(Ordering::Relaxed) {
                return Err("搜索已取消".into());
            }
            let dent = match dent {
                Ok(entry) => entry,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            if dent.file_type().is_some_and(|kind| kind.is_file()) { scanned += 1; }
            if scanned > scan_limit {
                truncated = true;
                break;
            }
            let path = dent.path();
            if path == root_path {
                continue;
            }
            let absolute = to_canon(path);
            if !seen_paths.insert(absolute) {
                continue;
            }
            let rel_inside = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => continue,
            };
            let rel = if multi_root {
                format!("{root_label}/{rel_inside}")
            } else {
                rel_inside
            };
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let candidate = SearchHit {
                path: display_path(path, &root_path, &root_display, &workspace),
                rel,
                name,
                is_dir,
            };
            if match_rank(&candidate, q).is_some() {
                matched += 1;
                if progress.is_some() { batch.push(candidate.clone()); }
                cands.push(candidate);
            }
            if published.elapsed() >= std::time::Duration::from_millis(200) && !batch.is_empty() { if let Some(publish) = progress { publish(std::mem::take(&mut batch)); } published = std::time::Instant::now(); }
            if cands.len() > cap.saturating_mul(2) {
                cands = rank_direct(cands, q, cap);
            }
        }
        if truncated {
            break;
        }
    }

    if let Some(publish) = progress { if !batch.is_empty() { publish(batch); } }
    let hits = rank_direct(cands, q, cap);
    Ok(SearchResult {
        hits,
        truncated: truncated || matched > cap,
        scanned,
        unreadable,
        scan_incomplete: truncated,
        matched,
    })
}

/// 名称优先，再匹配相对路径的全部分词，不使用默认模糊匹配。
fn match_rank(candidate: &SearchHit, query: &str) -> Option<u8> {
    let needle = query.trim().replace('\\', "/").to_lowercase();
    let name = candidate.name.to_lowercase();
    let rel = candidate.rel.to_lowercase();
    if name == needle {
        Some(0)
    } else if name.starts_with(&needle) {
        Some(1)
    } else if name.contains(&needle) {
        Some(2)
    } else if needle.split_whitespace().all(|word| rel.contains(word)) {
        Some(3)
    } else {
        None
    }
}

/// 对命中按名称相关度、名称长度和路径稳定排序。
fn rank_direct(cands: Vec<SearchHit>, query: &str, cap: usize) -> Vec<SearchHit> {
    let mut matched: Vec<(u8, usize, usize, SearchHit)> = cands
        .into_iter()
        .filter_map(|candidate| {
            match_rank(&candidate, query).map(|rank| {
                (
                    rank,
                    candidate.name.chars().count(),
                    candidate.rel.len(),
                    candidate,
                )
            })
        })
        .collect();
    matched.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.3.rel.cmp(&b.3.rel))
    });
    matched
        .into_iter()
        .take(cap)
        .map(|(_, _, _, candidate)| candidate)
        .collect()
}

#[derive(Serialize)]
pub struct ListFilesResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub fn fs_list_files(
    root: String,
    limit: Option<usize>,
    max_depth: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<ListFilesResult, String> {
    const DEFAULT_LIMIT: usize = 2_000;
    const HARD_LIMIT: usize = 10_000;
    const DEFAULT_DEPTH: usize = 8;
    const HARD_DEPTH: usize = 16;

    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, HARD_LIMIT);
    let depth = max_depth.unwrap_or(DEFAULT_DEPTH).clamp(1, HARD_DEPTH);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(depth))
        .filter_entry(keep_search_entry)
        .build();

    let mut files: Vec<String> = Vec::with_capacity(cap.min(256));
    let mut scanned: usize = 0;
    let mut truncated = false;

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let is_file = dent.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        files.push(rel);
        if files.len() >= cap {
            truncated = true;
            break;
        }
    }

    files.sort_by_key(|a| a.to_lowercase());
    Ok(ListFilesResult { files, truncated })
}

fn display_path(
    path: &std::path::Path,
    root_path: &std::path::Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
) -> String {
    if workspace.is_wsl() {
        if let Ok(rel) = path.strip_prefix(root_path) {
            let rel = to_canon(rel);
            return if rel.is_empty() {
                root_display.to_string()
            } else if root_display.ends_with('/') {
                format!("{root_display}{rel}")
            } else {
                format!("{root_display}/{rel}")
            };
        }
    }
    to_canon(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阈值只统计文件，恰好达到上限不提示，发现第一个超限文件才提示。
    #[test]
    fn file_budget_and_progress_are_exact() {
        let root = tempfile::tempdir().unwrap();
        for name in ["folder/a", "folder/b"] { let path = root.path().join(name); std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(path, "").unwrap(); }
        let batches = std::cell::RefCell::new(Vec::new());
        let publish = |hits: Vec<SearchHit>| batches.borrow_mut().extend(hits);
        let run = || search_walk(vec![root.path().to_string_lossy().into_owned()], "folder".into(), Some(1), None, Some(true), true, 2, &AtomicBool::new(false), Some(&publish)).unwrap();
        let exact = run(); assert_eq!(exact.scanned, 2); assert!(!exact.scan_incomplete); assert_eq!(exact.hits.len(), 3); assert_eq!(batches.borrow().len(), 3);
        std::fs::write(root.path().join("folder/c"), "").unwrap();
        let overflow = run(); assert_eq!(overflow.scanned, 3); assert!(overflow.scan_incomplete);
    }

    fn hit(rel: &str) -> SearchHit {
        SearchHit {
            path: rel.to_string(),
            rel: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn rank_direct_prefers_names_then_paths() {
        let cands = vec![
            hit("config/deeply/nested/readme.rs"),
            hit("config.rs"),
            hit("config/config.toml"),
        ];
        let out = rank_direct(cands, "config", 10);
        assert_eq!(out[0].rel, "config.rs");
        assert_eq!(out[1].rel, "config/config.toml");
        assert!(out
            .iter()
            .any(|h| h.rel == "config/deeply/nested/readme.rs"));
    }

    #[test]
    fn rank_direct_does_not_match_subsequence() {
        let cands = vec![hit("CommandPalette.tsx"), hit("readme.md")];
        let out = rank_direct(cands, "cmdp", 10);
        assert!(out.is_empty());
    }

    #[test]
    fn filename_search_includes_generated_trees() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/app.rs"), "fn main() {}").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join("target/debug/app.rs"), "generated").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "generated").unwrap();
        let result = fs_search(
            vec![root.to_string_lossy().into_owned()],
            "app".into(),
            Some(20),
            None,
            Some(false),
        )
        .expect("search");
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.rel.ends_with("src/app.rs")));
        assert!(result.hits.iter().any(|hit| hit.rel.contains("target")));
        assert!(!result
            .hits
            .iter()
            .any(|hit| hit.rel.contains("node_modules")));
    }

    /// 搜索取消与结果截断必须提供真实状态，单字中文和路径分词可命中。
    #[test]
    fn search_reports_limits_and_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["报一.txt", "报二.txt", ".报隐藏.txt"] { std::fs::write(directory.path().join(name), "").unwrap(); }
        let roots = vec![directory.path().to_string_lossy().into_owned()];
        let result = search_impl(roots.clone(), "报".into(), Some(1), None, Some(true), true, 50_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.matched, 3); assert!(result.truncated); assert!(!result.scan_incomplete);
        assert!(search_impl(roots, "报".into(), Some(1), None, Some(true), true, 50_000, &AtomicBool::new(true)).is_err());
        assert_eq!(rank_direct(vec![hit("src/report/main.rs")], "src main", 10).len(), 1);
    }
}
