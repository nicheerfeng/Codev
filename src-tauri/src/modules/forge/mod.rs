pub mod github;
pub mod types;

use super::vcs::VcsSnapshot;
use crate::modules::agent_host::protocol::now;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
pub use types::*;

const AUTH_CACHE_TTL: Duration = Duration::from_secs(180);
const MAX_CACHED_IMAGES: usize = 64;

#[derive(Clone)]
struct CachedAuth {
    resolved_at: Instant,
    pat_key: String,
    auth: ForgeAuthStatus,
    token: Option<String>,
}

#[derive(Default)]
pub struct ForgeService {
    pat_token: Mutex<Option<String>>,
    auth_cache: Mutex<Option<CachedAuth>>,
    cached: Mutex<HashMap<String, ForgeInboxSnapshot>>,
    image_cache: Mutex<HashMap<String, String>>,
    local_read_ids: Mutex<Vec<String>>,
}

impl ForgeService {
    pub fn load_persisted(&self, pat: Option<String>, read_ids: Vec<String>) {
        *self.pat_token.lock().unwrap() = pat.filter(|s| !s.trim().is_empty());
        *self.auth_cache.lock().unwrap() = None;
        *self.local_read_ids.lock().unwrap() = read_ids;
    }

    pub fn set_pat(&self, token: Option<String>) {
        *self.pat_token.lock().unwrap() = token
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        *self.auth_cache.lock().unwrap() = None;
    }

    pub fn cached_image(&self, url: &str) -> Option<String> {
        self.image_cache.lock().unwrap().get(url).cloned()
    }

    pub fn cache_image(&self, url: &str, data_url: String) {
        let mut cache = self.image_cache.lock().unwrap();
        if cache.len() >= MAX_CACHED_IMAGES && !cache.contains_key(url) {
            cache.clear();
        }
        cache.insert(url.to_string(), data_url);
    }

    pub fn mark_local_read(&self, id: &str) -> Vec<String> {
        let mut ids = self.local_read_ids.lock().unwrap();
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
            if ids.len() > 200 {
                let drain = ids.len() - 200;
                ids.drain(0..drain);
            }
        }
        for inbox in self.cached.lock().unwrap().values_mut() {
            for n in &mut inbox.notifications {
                if n.id == id {
                    n.unread = false;
                }
            }
            inbox.unread_count = inbox.notifications.iter().filter(|n| n.unread).count();
        }
        ids.clone()
    }

    pub fn resolve_token(&self) -> (ForgeAuthStatus, Option<String>) {
        let saved_pat = self.pat_token.lock().unwrap().clone();
        let pat_key = saved_pat.clone().unwrap_or_default();
        if let Some(cached) = self.auth_cache.lock().unwrap().as_ref() {
            if cached.pat_key == pat_key && cached.resolved_at.elapsed() < AUTH_CACHE_TTL {
                return (cached.auth.clone(), cached.token.clone());
            }
        }

        let (gh_installed, gh_tok) = github::detect_gh_cli();
        let (auth, token) = if let Some(tok) = saved_pat {
            let login = github::fetch_viewer_login(&tok);
            (
                ForgeAuthStatus {
                    source: "pat".into(),
                    authenticated: login.is_some(),
                    login,
                    has_saved_pat: true,
                    gh_installed,
                },
                Some(tok),
            )
        } else if let Some(tok) = gh_tok {
            let login = github::fetch_viewer_login(&tok);
            (
                ForgeAuthStatus {
                    source: "gh".into(),
                    authenticated: true,
                    login,
                    has_saved_pat: false,
                    gh_installed,
                },
                Some(tok),
            )
        } else {
            (
                ForgeAuthStatus {
                    source: "none".into(),
                    authenticated: false,
                    login: None,
                    has_saved_pat: false,
                    gh_installed,
                },
                None,
            )
        };

        *self.auth_cache.lock().unwrap() = Some(CachedAuth {
            resolved_at: Instant::now(),
            pat_key,
            auth: auth.clone(),
            token: token.clone(),
        });
        (auth, token)
    }

    pub fn detect_repo(snapshot: &VcsSnapshot) -> Option<ForgeRepoRef> {
        snapshot
            .remotes
            .iter()
            .find(|r| r.name == "origin")
            .or_else(|| snapshot.remotes.first())
            .and_then(|r| {
                github::parse_remote_url(&r.fetch_url)
                    .or_else(|| github::parse_remote_url(&r.push_url))
            })
    }

    pub fn cached_for(&self, repo_full_name: &str) -> Option<ForgeInboxSnapshot> {
        self.cached.lock().unwrap().get(repo_full_name).cloned()
    }

    pub fn all_cached(&self) -> Vec<ForgeInboxSnapshot> {
        self.cached.lock().unwrap().values().cloned().collect()
    }

    pub fn sync_repo(
        &self,
        repo: Option<ForgeRepoRef>,
        state_filter: &str,
    ) -> ForgeInboxSnapshot {
        let (auth, token) = self.resolve_token();
        let Some(repo_ref) = repo else {
            return ForgeInboxSnapshot {
                repo: None,
                auth,
                notifications: vec![],
                issues: vec![],
                pulls: vec![],
                unread_count: 0,
                last_synced_at: now(),
                error: None,
            };
        };

        let tok_ref = token.as_deref();
        let read_ids = self.local_read_ids.lock().unwrap().clone();
        let mut error_notes: Vec<String> = Vec::new();
        let viewer_login = auth.login.as_deref();

        let (notif_res, issues_res, pulls_res) = std::thread::scope(|scope| {
            let notif_handle = scope.spawn(|| match tok_ref {
                Some(tok) => github::fetch_notifications(&repo_ref, tok),
                None => Ok(vec![]),
            });
            let issues_handle =
                scope.spawn(|| github::fetch_issues(&repo_ref, tok_ref, state_filter, viewer_login));
            let pulls_handle = scope.spawn(|| github::fetch_pulls(&repo_ref, tok_ref, state_filter));
            (
                notif_handle
                    .join()
                    .unwrap_or_else(|_| Err("通知线程异常".into())),
                issues_handle
                    .join()
                    .unwrap_or_else(|_| Err("Issue 线程异常".into())),
                pulls_handle
                    .join()
                    .unwrap_or_else(|_| Err("PR 线程异常".into())),
            )
        });

        let mut notifications = match notif_res {
            Ok(list) => list,
            Err(e) => {
                error_notes.push(e);
                vec![]
            }
        };
        for n in &mut notifications {
            if read_ids.iter().any(|id| id == &n.id) {
                n.unread = false;
            }
        }

        let issues = match issues_res {
            Ok(list) => list,
            Err(e) => {
                error_notes.push(e);
                vec![]
            }
        };

        let pulls = match pulls_res {
            Ok(list) => list,
            Err(e) => {
                error_notes.push(e);
                vec![]
            }
        };

        let unread_count = notifications.iter().filter(|n| n.unread).count();
        let snap = ForgeInboxSnapshot {
            repo: Some(repo_ref.clone()),
            auth,
            notifications,
            issues,
            pulls,
            unread_count,
            last_synced_at: now(),
            error: (!error_notes.is_empty()).then(|| error_notes.join("；")),
        };
        self.cached
            .lock()
            .unwrap()
            .insert(repo_ref.full_name, snap.clone());
        snap
    }
}
