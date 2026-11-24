use super::repo::resolve_repo_context;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(220);
const MAX_WAIT: Duration = Duration::from_millis(1200);

struct WatchedRepo {
    worktree_root: PathBuf,
    git_dir: PathBuf,
    common_git_dir: PathBuf,
    raw_cwd: String,
}

enum WatchMsg {
    SyncRoots(Vec<String>),
    Notify(PathBuf),
    Shutdown,
}

pub struct VcsWatcher {
    tx: Mutex<Option<mpsc::Sender<WatchMsg>>>,
}

impl Default for VcsWatcher {
    fn default() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }
}

fn should_ignore_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    if lower.contains("node_modules")
        || lower.contains("\\target\\")
        || lower.contains("/target/")
        || lower.contains("index.lock")
    {
        return true;
    }
    if lower.contains(".git") {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let is_refs = lower.contains("refs");
        let is_git_meta = matches!(
            name,
            "HEAD" | "index" | "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "packed-refs"
        );
        return !(is_refs || is_git_meta);
    }
    false
}

impl VcsWatcher {
    pub fn start<F>(&self, on_change: F)
    where
        F: Fn(String) + Send + 'static,
    {
        let mut guard = self.tx.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<WatchMsg>();
        *guard = Some(tx.clone());
        let fs_tx = tx.clone();

        std::thread::Builder::new()
            .name("codev-vcs-watcher".into())
            .spawn(move || {
                let Ok(mut watcher) = RecommendedWatcher::new(
                    move |res: Result<Event, notify::Error>| {
                        if let Ok(ev) = res {
                            for p in ev.paths {
                                if !should_ignore_path(&p) {
                                    let _ = fs_tx.send(WatchMsg::Notify(p));
                                }
                            }
                        }
                    },
                    Config::default(),
                ) else {
                    return;
                };

                let mut repos: Vec<WatchedRepo> = Vec::new();
                let mut watched_dirs: HashSet<PathBuf> = HashSet::new();
                let mut pending_roots: HashMap<String, Instant> = HashMap::new();
                let mut batch_started: Option<Instant> = None;

                let sync_watchers = |watcher: &mut RecommendedWatcher,
                                     watched_dirs: &mut HashSet<PathBuf>,
                                     repos: &mut Vec<WatchedRepo>,
                                     cwds: Vec<String>| {
                    let mut next_repos = Vec::new();
                    let mut desired_dirs: HashSet<(PathBuf, RecursiveMode)> = HashSet::new();
                    let mut seen_wt = HashSet::new();
                    for cwd in cwds {
                        let Ok(Some(ctx)) = resolve_repo_context(Path::new(&cwd)) else {
                            continue;
                        };
                        if !seen_wt.insert(ctx.worktree_root.clone()) {
                            continue;
                        }
                        let wt = PathBuf::from(&ctx.worktree_root);
                        let gd = PathBuf::from(&ctx.git_dir);
                        let cgd = PathBuf::from(&ctx.common_git_dir);
                        desired_dirs.insert((wt.clone(), RecursiveMode::Recursive));
                        desired_dirs.insert((gd.clone(), RecursiveMode::NonRecursive));
                        let refs_dir = cgd.join("refs");
                        if refs_dir.is_dir() {
                            desired_dirs.insert((refs_dir, RecursiveMode::Recursive));
                        }
                        next_repos.push(WatchedRepo {
                            worktree_root: wt,
                            git_dir: gd,
                            common_git_dir: cgd,
                            raw_cwd: ctx.worktree_root,
                        });
                    }
                    let desired_paths: HashSet<PathBuf> =
                        desired_dirs.iter().map(|(p, _)| p.clone()).collect();
                    for old in watched_dirs.difference(&desired_paths).cloned().collect::<Vec<_>>() {
                        let _ = watcher.unwatch(&old);
                        watched_dirs.remove(&old);
                    }
                    for (dir, mode) in desired_dirs {
                        if !watched_dirs.contains(&dir) && watcher.watch(&dir, mode).is_ok() {
                            watched_dirs.insert(dir);
                        }
                    }
                    *repos = next_repos;
                };

                loop {
                    let timeout = if let (Some(started), Some(oldest)) =
                        (batch_started, pending_roots.values().copied().min())
                    {
                        let since = started.elapsed();
                        let max_rem = MAX_WAIT.saturating_sub(since);
                        let gap_rem = DEBOUNCE.saturating_sub(oldest.elapsed());
                        max_rem.min(gap_rem).max(Duration::from_millis(20))
                    } else {
                        Duration::from_secs(5)
                    };

                    match rx.recv_timeout(timeout) {
                        Ok(WatchMsg::Shutdown) => break,
                        Ok(WatchMsg::SyncRoots(cwds)) => {
                            sync_watchers(&mut watcher, &mut watched_dirs, &mut repos, cwds);
                        }
                        Ok(WatchMsg::Notify(path)) => {
                            let now = Instant::now();
                            if batch_started.is_none() {
                                batch_started = Some(now);
                            }
                            for r in &repos {
                                if path.starts_with(&r.worktree_root)
                                    || path.starts_with(&r.git_dir)
                                    || path.starts_with(&r.common_git_dir)
                                {
                                    pending_roots.insert(r.raw_cwd.clone(), now);
                                }
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }

                    let should_flush = !pending_roots.is_empty()
                        && (batch_started.is_some_and(|s| s.elapsed() >= MAX_WAIT)
                            || pending_roots
                                .values()
                                .all(|t| t.elapsed() >= DEBOUNCE));
                    if should_flush {
                        let ready: Vec<String> = pending_roots.drain().map(|(k, _)| k).collect();
                        batch_started = None;
                        for cwd in ready {
                            on_change(cwd);
                        }
                    }
                }
            })
            .ok();
    }

    pub fn sync_roots(&self, cwds: Vec<String>) {
        if let Some(ref tx) = *self.tx.lock().unwrap() {
            let _ = tx.send(WatchMsg::SyncRoots(cwds));
        }
    }

    pub fn shutdown(&self) {
        if let Some(ref tx) = *self.tx.lock().unwrap() {
            let _ = tx.send(WatchMsg::Shutdown);
        }
    }
}
