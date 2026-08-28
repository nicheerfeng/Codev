use std::collections::HashSet;

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
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

#[tauri::command]
pub fn fs_search(
    roots: Vec<String>,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
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
    let mut seen_paths = HashSet::new();

    for (root_display, root_path, root_label) in resolved_roots {
        let walker = WalkBuilder::new(&root_path)
            .hidden(!show_hidden)
            // Filename search follows the visible file tree, including files
            // under ignored or commonly generated directories.
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(true)
            .follow_links(false)
            .build();

        for dent in walker.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED {
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
            cands.push(SearchHit {
                path: display_path(path, &root_path, &root_display, &workspace),
                rel,
                name,
                is_dir,
            });
        }
        if truncated {
            break;
        }
    }

    let hits = rank_direct(cands, q, cap);
    Ok(SearchResult { hits, truncated })
}

/// 按文件名或目录名做大小写不敏感的直接包含匹配，不读取或模糊匹配路径。
fn rank_direct(cands: Vec<SearchHit>, query: &str, cap: usize) -> Vec<SearchHit> {
    let needle = query.to_lowercase();
    let mut matched: Vec<(u8, usize, usize, SearchHit)> = cands
        .into_iter()
        .filter_map(|candidate| {
            let name = candidate.name.to_lowercase();
            if !name.contains(&needle) {
                return None;
            }
            let rank = if name == needle {
                0
            } else if name.starts_with(&needle) {
                1
            } else {
                2
            };
            Some((rank, name.chars().count(), candidate.rel.len(), candidate))
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
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
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

    fn hit(rel: &str) -> SearchHit {
        SearchHit {
            path: rel.to_string(),
            rel: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn rank_direct_matches_names_only() {
        let cands = vec![
            hit("config/deeply/nested/readme.rs"),
            hit("config.rs"),
            hit("config/config.toml"),
        ];
        let out = rank_direct(cands, "config", 10);
        assert_eq!(out[0].rel, "config.rs");
        assert_eq!(out[1].rel, "config/config.toml");
        assert!(!out
            .iter()
            .any(|h| h.rel == "config/deeply/nested/readme.rs"));
    }

    #[test]
    fn rank_direct_does_not_match_subsequence() {
        let cands = vec![hit("CommandPalette.tsx"), hit("readme.md")];
        let out = rank_direct(cands, "cmdp", 10);
        assert!(out.is_empty());
    }
}
