//! Host-owned state, ordered snapshots and one supervised runtime per session.
use super::{
    antigravity_history,
    bridge::{lock, Bridge, Wire},
    history,
    metadata::{self, MetadataStore},
    native_history::NativeHistory,
    protocol::*,
    registry,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

#[derive(Clone, Debug, Default)]
pub struct PendingRuntimeConfig {
    pub model: Option<(String, String)>,
    pub thinking: Option<String>,
    pub configs: Vec<(String, String)>,
}

impl PendingRuntimeConfig {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.thinking.is_none() && self.configs.is_empty()
    }

    pub fn set_config(&mut self, config_id: String, value: String) {
        if let Some(existing) = self.configs.iter_mut().find(|(id, _)| id == &config_id) {
            existing.1 = value;
        } else {
            self.configs.push((config_id, value));
        }
    }

    pub fn overlay_on_view(&self, view: &mut SessionView) {
        if let Some((ref provider, ref model_id)) = self.model {
            let matched = view
                .models
                .iter()
                .find(|m| {
                    text(m, "id") == *model_id
                        && (provider.is_empty()
                            || text(m, "provider").is_empty()
                            || text(m, "provider") == *provider)
                })
                .cloned();
            if let Some(found) = matched {
                view.model = Some(found);
            } else {
                view.model = Some(json!({
                    "id": model_id,
                    "provider": if provider.is_empty() { view.binding.harness_id.clone() } else { provider.clone() },
                    "name": model_id,
                }));
            }
            for opt in &mut view.config_options {
                if text(opt, "category") == "model" || text(opt, "id") == "model" {
                    opt["currentValue"] = json!(model_id);
                }
            }
        }
        if let Some(ref level) = self.thinking {
            view.thinking_level = level.clone();
            for opt in &mut view.config_options {
                let category = text(opt, "category");
                let oid = text(opt, "id");
                if matches!(category.as_str(), "thought_level" | "thinking")
                    || oid.contains("thinking")
                    || oid == "thought_level"
                {
                    opt["currentValue"] = json!(level);
                }
            }
        }
        for (config_id, val) in &self.configs {
            if let Some(opt) = view.config_options.iter_mut().find(|o| text(o, "id") == *config_id) {
                opt["currentValue"] = json!(val);
            }
        }
    }
}

pub struct Runtime {
    pub instance: String,
    pub bridge: Arc<Bridge>,
    pub native_id: Mutex<Option<String>>,
    pub gate: tokio::sync::Mutex<()>,
    pub reply_gate: tokio::sync::Mutex<()>,
    pub permission_ids: Mutex<HashMap<String, Value>>,
    pub fs_approvals: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    pub session_auto_write: AtomicBool,
    pub cancelled: AtomicBool,
    pub closing: AtomicBool,
    pub loading_history: AtomicBool,
    pub loading_desktop_history: AtomicBool,
    pub supports_prompt_steer: AtomicBool,
    pub active_prompts: AtomicUsize,
    pub cancel_seq: AtomicU64,
    pub last_activity_ms: AtomicU64,
    pub update_steps_calls: Mutex<HashSet<String>>,
    pub pending_config: Mutex<PendingRuntimeConfig>,
}

impl Runtime {
    pub fn touch_activity(&self) {
        self.last_activity_ms.store(now_ms(), Ordering::Release);
    }
}
pub struct State {
    pub sequence: u64,
    pub workspaces: BTreeMap<String, Workspace>,
    pub sessions: BTreeMap<String, SessionView>,
    pub dirty: HashSet<String>,
    pub dirty_messages: HashMap<String, HashSet<String>>,
    pub global_dirty: bool,
    pub published_messages: HashMap<String, HashMap<String, Message>>,
}
pub type Outcome = Result<Value, String>;
pub struct CachedRequest {
    pub fingerprint: String,
    pub reply: watch::Sender<Option<Outcome>>,
}
const RETIRED_HARNESSES: &[&str] = &["acp:claude", "acp:gemini"];

pub struct Host {
    pub id: String,
    pub desktop_token: String,
    pub state: Mutex<State>,
    pub store: Mutex<MetadataStore>,
    pub runtimes: Mutex<HashMap<String, Arc<Runtime>>>,
    pub opening: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub events: broadcast::Sender<Event>,
    pub requests: Mutex<HashMap<String, CachedRequest>>,
    pub completed: Mutex<VecDeque<String>>,
    pub auth: Mutex<super::auth::PairingState>,
    pub remote: Mutex<Option<super::server::RemoteListener>>,
    pub remote_enabled: std::sync::atomic::AtomicBool,
    pub web_directory: PathBuf,
    pub directory: PathBuf,
    pub shutdown: tokio::sync::Notify,
    native_history: Mutex<NativeHistory>,
    pub(super) native_refresh: tokio::sync::Mutex<()>,
    pub(super) usage_sync: tokio::sync::Mutex<()>,
    pub(super) provider_gate: tokio::sync::RwLock<()>,
    pub vcs: Arc<crate::modules::vcs::VcsService>,
    pub vcs_watcher: crate::modules::vcs::VcsWatcher,
    vcs_refresh_inflight: Mutex<HashMap<String, bool>>,
    pub vcs_background_enabled: std::sync::atomic::AtomicBool,
    pub forge: Arc<crate::modules::forge::ForgeService>,
}
pub(super) fn native_session_key(binding: &SessionBinding) -> String {
    format!("{}:{}", binding.harness_id, binding.native_session_id.as_deref().unwrap_or_default())
}
impl Host {
    pub fn open(directory: PathBuf, web_directory: PathBuf) -> Result<Arc<Self>, String> {
        let store = MetadataStore::open(&directory)?;
        let workspaces = store
            .workspaces()?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        let sessions = store
            .sessions()?
            .into_iter()
            .filter(|binding| {
                binding
                    .native_session_path
                    .as_ref()
                    .map_or(true, |path| !std::fs::metadata(path)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound))
            })
            .map(|mut b| {
                if b.harness_id == "acp:codex" && b.imported && b.native_session_id.is_some() {
                    b.read_only = false;
                }
                (b.id.clone(), SessionView::new(b))
            })
            .collect();
        let (events, _) = broadcast::channel(512);
        let forge = Arc::new(crate::modules::forge::ForgeService::default());
        let saved_pat = store
            .preference("forgePat")
            .and_then(|v| v.as_str().map(str::to_string));
        let read_ids = store
            .preference("forgeReadIds")
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default();
        forge.load_persisted(saved_pat, read_ids);
        let vcs_bg = store
            .preference("gitUiEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        Ok(Arc::new(Self {
            id: new_id(),
            desktop_token: super::auth::secret(),
            state: Mutex::new(State {
                sequence: 0,
                workspaces,
                sessions,
                dirty: HashSet::new(),
                dirty_messages: HashMap::new(),
                global_dirty: false,
                published_messages: HashMap::new(),
            }),
            store: Mutex::new(store),
            runtimes: Mutex::new(HashMap::new()),
            opening: tokio::sync::Mutex::new(HashMap::new()),
            events,
            requests: Mutex::new(HashMap::new()),
            completed: Mutex::new(VecDeque::new()),
            auth: Mutex::new(super::auth::PairingState::default()),
            remote: Mutex::new(None),
            remote_enabled: std::sync::atomic::AtomicBool::new(false),
            web_directory,
            directory,
            shutdown: tokio::sync::Notify::new(),
            native_history: Mutex::new(NativeHistory::default()),
            native_refresh: tokio::sync::Mutex::new(()),
            usage_sync: tokio::sync::Mutex::new(()),
            provider_gate: tokio::sync::RwLock::new(()),
            vcs: Arc::new(crate::modules::vcs::VcsService::default()),
            vcs_watcher: crate::modules::vcs::VcsWatcher::default(),
            vcs_refresh_inflight: Mutex::new(HashMap::new()),
            vcs_background_enabled: std::sync::atomic::AtomicBool::new(vcs_bg),
            forge,
        }))
    }
    pub fn remote_active(&self) -> bool {
        self.remote_enabled.load(std::sync::atomic::Ordering::Acquire)
            || lock(&self.remote).is_some()
    }
    pub fn host_tools_policy(&self, harness_id: &str) -> HostToolsPolicy {
        lock(&self.store)
            .preference("hostToolsPolicy")
            .and_then(|value| value.get(harness_id).cloned())
            .and_then(|value| serde_json::from_value::<HostToolsPolicy>(value).ok())
            .unwrap_or_default()
    }
    pub fn harness_preferences(&self, harness_id: &str) -> SessionPreferences {
        lock(&self.store)
            .preference("harnessPreferences")
            .and_then(|value| value.get(harness_id).cloned())
            .and_then(|value| serde_json::from_value::<SessionPreferences>(value).ok())
            .unwrap_or_default()
    }
    pub fn save_harness_preferences(
        &self,
        harness_id: &str,
        update: impl FnOnce(&mut SessionPreferences),
    ) -> Result<(), String> {
        let store = lock(&self.store);
        let mut all = store
            .preference("harnessPreferences")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut prefs = all
            .get(harness_id)
            .cloned()
            .and_then(|value| serde_json::from_value::<SessionPreferences>(value).ok())
            .unwrap_or_default();
        update(&mut prefs);
        if prefs.is_empty() {
            all.remove(harness_id);
        } else {
            all.insert(
                harness_id.into(),
                serde_json::to_value(&prefs).map_err(|e| e.to_string())?,
            );
        }
        store.set_preference("harnessPreferences", &Value::Object(all))
    }
    pub fn record_session_preference(
        &self,
        id: &str,
        save_harness: bool,
        mut update: impl FnMut(&mut SessionPreferences),
    ) -> Result<(), String> {
        let (binding, harness_id) = {
            let mut state = lock(&self.state);
            let view = state.sessions.get_mut(id).ok_or("会话不存在")?;
            if view.binding.read_only {
                return Ok(());
            }
            update(&mut view.binding.preferences);
            (view.binding.clone(), view.binding.harness_id.clone())
        };
        lock(&self.store).save_session(&binding)?;
        if save_harness {
            self.save_harness_preferences(&harness_id, |prefs| update(prefs))?;
        }
        Ok(())
    }
    pub fn start_background(self: &Arc<Self>) {
        self.start_vcs_and_forge();
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(600));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                let Some(host) = weak.upgrade() else { break };
                let _guard = host.usage_sync.lock().await;
                let directory = host.directory.clone();
                match tokio::task::spawn_blocking(move || super::usage::sync(&directory)).await {
                    Ok(Ok(_)) => {},
                    Ok(Err(error)) => log::warn!("用量同步失败：{error}"),
                    Err(error) => log::warn!("用量同步任务失败：{error}"),
                }
            }
        });
        let host = self.clone();
        tokio::spawn(async move {
            if let Err(error) = host.refresh_native_history().await {
                log::warn!("原生会话刷新失败：{error}");
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(60));
            loop {
                ticker.tick().await;
                let Some(host) = weak.upgrade() else { break };
                host.flush();
            }
        });
    }

    fn start_vcs_and_forge(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let rt = tokio::runtime::Handle::try_current().ok();
        self.vcs_watcher.start(move |cwd| {
            let Some(host) = weak.upgrade() else { return };
            if !host.vcs_background_enabled() {
                return;
            }
            if let Some(ref handle) = rt {
                handle.spawn(async move {
                    host.refresh_vcs_snapshot(&cwd).await;
                });
            }
        });
        self.sync_vcs_watchers();

        // Initial snapshot & forge background poller (120s)
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let cwds: Vec<String> = {
                let Some(host) = weak.upgrade() else { return };
                if !host.vcs_background_enabled() {
                    Vec::new()
                } else {
                    lock(&host.state)
                        .workspaces
                        .values()
                        .map(|w| w.cwd.clone())
                        .collect()
                }
            };
            for cwd in cwds {
                let Some(host) = weak.upgrade() else { return };
                host.refresh_vcs_snapshot(&cwd).await;
            }
            let mut ticker = tokio::time::interval(Duration::from_secs(120));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                let Some(host) = weak.upgrade() else { break };
                host.sync_watched_forge_repos().await;
            }
        });
    }

    pub fn vcs_background_enabled(&self) -> bool {
        self.vcs_background_enabled
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn set_vcs_background_enabled(&self, enabled: bool) -> Result<(), String> {
        lock(&self.store).set_preference("gitUiEnabled", &json!(enabled))?;
        self.vcs_background_enabled
            .store(enabled, std::sync::atomic::Ordering::Release);
        self.sync_vcs_watchers();
        Ok(())
    }

    pub fn sync_vcs_watchers(&self) {
        if !self.vcs_background_enabled() {
            self.vcs_watcher.sync_roots(Vec::new());
            return;
        }
        let cwds: Vec<String> = lock(&self.state)
            .workspaces
            .values()
            .map(|w| w.cwd.clone())
            .collect();
        self.vcs_watcher.sync_roots(cwds);
    }

    pub async fn refresh_vcs_snapshot(&self, cwd: &str) {
        let key = {
            let norm = cwd.replace('\\', "/").trim_end_matches('/').to_string();
            if cfg!(windows) { norm.to_ascii_lowercase() } else { norm }
        };
        {
            let mut inflight = lock(&self.vcs_refresh_inflight);
            if let Some(pending) = inflight.get_mut(&key) {
                *pending = true;
                return;
            }
            inflight.insert(key.clone(), false);
        }

        loop {
            let vcs = self.vcs.clone();
            let target = cwd.to_string();
            if let Ok(Ok(Some(snapshot))) =
                tokio::task::spawn_blocking(move || vcs.snapshot(&target)).await
            {
                self.emit_event("vcs.changed", json!({ "snapshot": snapshot }));
            }
            let rerun = {
                let mut inflight = lock(&self.vcs_refresh_inflight);
                if inflight.get(&key).copied() == Some(true) {
                    inflight.insert(key.clone(), false);
                    true
                } else {
                    inflight.remove(&key);
                    false
                }
            };
            if !rerun {
                break;
            }
        }
    }

    pub async fn sync_watched_forge_repos(&self) {
        let snapshots = self.vcs.cached_snapshots();
        let mut seen = HashSet::new();
        for snap in snapshots {
            let Some(repo) = crate::modules::forge::ForgeService::detect_repo(&snap) else {
                continue;
            };
            if !seen.insert(repo.full_name.clone()) {
                continue;
            }
            let forge = self.forge.clone();
            if let Ok(inbox) =
                tokio::task::spawn_blocking(move || forge.sync_repo(Some(repo), "open")).await
            {
                self.emit_event("forge.updated", json!({ "inbox": inbox }));
            }
        }
    }

    pub fn emit_event(&self, kind: &str, payload: Value) {
        let mut state = lock(&self.state);
        state.sequence += 1;
        let _ = self.events.send(Event {
            protocol_version: PROTOCOL_VERSION,
            sequence: state.sequence,
            kind: kind.to_string(),
            session_id: None,
            instance_id: None,
            payload,
        });
    }

    pub fn session_cwd(&self, id: &str) -> Option<String> {
        let state = lock(&self.state);
        let wid = &state.sessions.get(id)?.binding.workspace_id;
        state.workspaces.get(wid).map(|w| w.cwd.clone())
    }

    pub fn require_vcs_write(&self, principal: &Principal) -> Result<(), String> {
        if principal.desktop {
            return Ok(());
        }
        let allowed = lock(&self.store)
            .preference("remoteWriteDevices")
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some(&principal.id)));
        if allowed {
            Ok(())
        } else {
            Err("移动端当前为只读投影模式，请在桌面端“远程设备授权”中开启该设备的 Git 写权限".into())
        }
    }

    pub fn set_device_write(&self, device_id: &str, enabled: bool) -> Result<Vec<String>, String> {
        let store = lock(&self.store);
        let mut list = store
            .preference("remoteWriteDevices")
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default();
        if enabled {
            if !list.iter().any(|id| id == device_id) {
                list.push(device_id.to_string());
            }
        } else {
            list.retain(|id| id != device_id);
        }
        store.set_preference("remoteWriteDevices", &json!(list))?;
        Ok(list)
    }
    pub fn flush(&self) {
        let outgoing = {
            let mut state = lock(&self.state);
            let mut events_to_send = Vec::new();
            let ids = state.dirty.drain().collect::<Vec<_>>();
            for id in ids {
                let Some((view, order, changed, summary_val, instance_id)) = ({
                    let state_ref = &mut *state;
                    state_ref.sessions.get(&id).map(|session| {
                        let dirty_set = state_ref.dirty_messages.remove(&id);
                        let published = state_ref.published_messages.entry(id.clone()).or_default();
                        let mut changed = Vec::new();
                        let mut order = Vec::with_capacity(session.messages.len());
                        let mut current_ids = HashSet::with_capacity(session.messages.len());
                        let full_check = published.is_empty() && !session.messages.is_empty();
                        for m in &session.messages {
                            order.push(m.id.clone());
                            current_ids.insert(m.id.clone());
                            let candidate = full_check
                                || dirty_set.as_ref().is_none_or(|d| d.contains(&m.id))
                                || !published.contains_key(&m.id);
                            if candidate && published.get(&m.id) != Some(m) {
                                changed.push(m.clone());
                                published.insert(m.id.clone(), m.clone());
                            }
                        }
                        if published.len() > current_ids.len() {
                            published.retain(|mid, _| current_ids.contains(mid));
                        }
                        let view = session.clone_without_messages();
                        let summary_val = summary(session);
                        let instance_id = session.instance_id.clone();
                        (view, order, changed, summary_val, instance_id)
                    })
                }) else {
                    state.dirty_messages.remove(&id);
                    continue;
                };
                state.sequence += 1;
                events_to_send.push(Event {
                    protocol_version: PROTOCOL_VERSION,
                    sequence: state.sequence,
                    kind: "session.patch".into(),
                    session_id: Some(id),
                    instance_id,
                    payload: json!({
                        "view": view,
                        "messageOrder": order,
                        "messageUpserts": changed,
                        "summary": summary_val,
                    }),
                });
            }
            if state.global_dirty {
                state.global_dirty = false;
                state.sequence += 1;
                events_to_send.push(Event {
                    protocol_version: PROTOCOL_VERSION,
                    sequence: state.sequence,
                    kind: "host.changed".into(),
                    session_id: None,
                    instance_id: None,
                    payload: json!({
                        "workspaces": state.workspaces.values().collect::<Vec<_>>(),
                        "sessions": state.sessions.values().map(summary).collect::<Vec<_>>(),
                        "harnesses": self.harnesses(),
                    }),
                });
            }
            events_to_send
        };
        for event in outgoing {
            let _ = self.events.send(event);
        }
    }
    pub fn snapshot(&self) -> Value {
        let state = lock(&self.state);
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverId": self.id,
            "sequence": state.sequence,
            "workspaces": state.workspaces.values().collect::<Vec<_>>(),
            "sessions": state.sessions.values().map(summary).collect::<Vec<_>>(),
            "harnesses": self.harnesses(),
            "vcsSnapshots": self.vcs.cached_snapshots(),
            "forgeInboxes": self.forge.all_cached(),
        })
    }

    /// Remote clients get identities and capability flags, never local command lines.
    pub fn snapshot_for(&self, desktop: bool) -> Value {
        if desktop {
            return self.snapshot();
        }
        let state = lock(&self.state);
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "serverId": self.id,
            "sequence": state.sequence,
            "workspaces": state.workspaces.values().collect::<Vec<_>>(),
            "sessions": state.sessions.values().map(summary).collect::<Vec<_>>(),
            "harnesses": self.harnesses().iter().map(remote_harness).collect::<Vec<_>>(),
            "vcsSnapshots": self.vcs.cached_snapshots(),
            "forgeInboxes": self.forge.all_cached(),
        })
    }
    pub fn view(&self, id: &str) -> Result<SessionView, String> {
        lock(&self.state)
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "会话不存在".into())
    }
    pub fn update(&self, id: &str, instance: Option<&str>, f: impl FnOnce(&mut SessionView)) {
        let mut state = lock(&self.state);
        let dirty_ids = if let Some(view) = state.sessions.get_mut(id) {
            if instance.is_some() && view.instance_id.as_deref() != instance {
                return;
            }
            let prev_len = view.messages.len();
            let prev_tail = view.messages.last().map(|m| (
                m.id.clone(),
                m.text.len(),
                m.thinking.len(),
                m.streaming,
                m.status.clone(),
                m.tool_call_id.clone(),
                m.is_error,
                m.locations.len(),
                m.diff.is_some(),
                m.images.len(),
                m.arguments.to_string().len(),
            ));
            f(view);
            view.revision += 1;
            view.binding.updated_at = now();
            // Bound the live presentation. Native history remains intact and pageable.
            if view.messages.len() > 600 {
                let remove = view.messages.len() - 600;
                view.messages.drain(..remove);
                view.truncated = true;
            }
            let mut bytes = 0usize;
            for message in view.messages.iter_mut().rev() {
                for content in [&mut message.text, &mut message.thinking] {
                    if content.len() > 256 * 1024 {
                        let mut end = 256 * 1024;
                        while !content.is_char_boundary(end) {
                            end -= 1;
                        }
                        content.truncate(end);
                        content.push_str("\n[实时展示已截断，完整内容保留在原生历史中]");
                        view.truncated = true;
                    }
                    bytes += content.len();
                }
                if matches!(message.arguments, Value::String(ref s) if s.len() > 128 * 1024) {
                    message.clamp_arguments_size();
                    view.truncated = true;
                }
                for image in &mut message.images {
                    if image
                        .get("data")
                        .and_then(Value::as_str)
                        .map(|s| s.len() > 256 * 1024)
                        .unwrap_or(false)
                    {
                        *image = json!({"type":"image","mimeType":image.get("mimeType"),"unavailable":true});
                    }
                }
            }
            while bytes > 4 * 1024 * 1024 && view.messages.len() > 1 {
                let first = view.messages.remove(0);
                bytes = bytes.saturating_sub(first.text.len() + first.thinking.len());
                view.truncated = true;
            }
            let mut tracked: Vec<String> = Vec::new();
            let tail_same_id = prev_tail.as_ref().is_some_and(|(tid, ..)| {
                view.messages.len() == prev_len
                    && view.messages.last().is_some_and(|m| m.id == *tid)
            });
            let tail_changed = tail_same_id
                && prev_tail.as_ref().is_some_and(|prev| {
                    view.messages.last().is_some_and(|m| {
                        (
                            m.id.as_str(),
                            m.text.len(),
                            m.thinking.len(),
                            m.streaming,
                            m.status.as_str(),
                            m.tool_call_id.as_str(),
                            m.is_error,
                            m.locations.len(),
                            m.diff.is_some(),
                            m.images.len(),
                            m.arguments.to_string().len(),
                        ) != (
                            prev.0.as_str(),
                            prev.1,
                            prev.2,
                            prev.3,
                            prev.4.as_str(),
                            prev.5.as_str(),
                            prev.6,
                            prev.7,
                            prev.8,
                            prev.9,
                            prev.10,
                        )
                    })
                });
            if tail_changed {
                if let Some(last) = view.messages.last() {
                    tracked.push(last.id.clone());
                }
            } else if prev_len > 0 && view.messages.len() > prev_len {
                for m in &view.messages[prev_len.saturating_sub(1)..] {
                    tracked.push(m.id.clone());
                }
            } else if !tail_same_id || prev_len != view.messages.len() {
                for m in &view.messages {
                    tracked.push(m.id.clone());
                }
            } else {
                // Same length and tail looks untouched: either a non-message field changed or an earlier message changed.
                for m in &view.messages {
                    tracked.push(m.id.clone());
                }
            }
            Some(tracked)
        } else {
            None
        };
        if let Some(tracked) = dirty_ids {
            state.dirty.insert(id.to_string());
            let entry = state.dirty_messages.entry(id.to_string()).or_default();
            for mid in tracked {
                entry.insert(mid);
            }
        }
    }
    pub fn persist(&self, id: &str) -> Result<(), String> {
        let binding = self.view(id)?.binding;
        lock(&self.store).save_session(&binding)
    }
    pub fn harnesses(&self) -> Vec<HarnessDescriptor> {
        let mut all = registry::defaults();
        if let Some(value) = lock(&self.store).preference("harnesses") {
            if let Ok(mut custom) = serde_json::from_value::<Vec<HarnessDescriptor>>(value) {
                let before = custom.len();
                custom.retain(|d| !RETIRED_HARNESSES.contains(&d.id.as_str()));
                if custom.len() != before {
                    let _ = lock(&self.store).set_preference("harnesses", &json!(custom));
                }
                for mut d in custom {
                    let baseline = registry::baseline_capabilities(&d.id, &d.kind);
                    if d.capabilities == Capabilities::default() {
                        d.capabilities = baseline;
                    }
                    if let Some(old) = all.iter_mut().find(|p| p.id == d.id) {
                        d.installed = registry::launch(&d).is_ok();
                        *old = d;
                    } else {
                        d.installed = registry::resolve_binary(&d.command).is_some();
                        all.push(d);
                    }
                }
            }
        }
        all
    }

    /// Retire harnesses removed from the product without touching native transcripts.
    pub fn retire_removed_harnesses(&self) -> Result<(), String> {
        let retired: Vec<String> = lock(&self.state)
            .sessions
            .values()
            .filter(|view| RETIRED_HARNESSES.contains(&view.binding.harness_id.as_str()))
            .map(|view| view.binding.id.clone())
            .collect();
        for id in retired {
            self.update(&id, None, |view| {
                view.binding.archived = true;
                view.binding.read_only = true;
            });
            self.persist(&id)?;
        }
        Ok(())
    }
    pub fn workspace(&self, cwd: &str) -> Result<Workspace, String> {
        let path = metadata::canonical_workspace(cwd)?;
        let cwd = metadata::display_path(&path);
        let id = metadata::stable_id("workspace", &cwd);
        let workspace = Workspace {
            id: id.clone(),
            title: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| cwd.clone()),
            cwd,
            manual: true,
        };
        lock(&self.store).save_workspace(&workspace)?;
        let mut state = lock(&self.state);
        state.workspaces.insert(id, workspace.clone());
        state.global_dirty = true;
        drop(state);
        self.sync_vcs_watchers();
        Ok(workspace)
    }
    pub async fn refresh_native_history(self: &Arc<Self>) -> Result<(), String> {
        let _gate = self.native_refresh.lock().await;
        let workspaces: Vec<Workspace> = lock(&self.state).workspaces.values().cloned().collect();
        if workspaces.is_empty() { return Ok(()); }
        let host = self.clone();
        let (discovered, errors) = tokio::task::spawn_blocking(move || {
            lock(&host.native_history).scan(&workspaces)
        }).await.map_err(|error| error.to_string())?;
        self.apply_native_history(discovered)?;
        if errors.is_empty() { Ok(()) } else { Err(errors.join("\n")) }
    }
    pub(super) fn apply_native_history(&self, discovered: Vec<(PathBuf, SessionBinding)>) -> Result<(), String> {
        let (hidden, saved_sessions) = {
            let store = lock(&self.store);
            let hidden = store.preference("hiddenNativeSessions")
                .and_then(|value| serde_json::from_value::<HashSet<String>>(value).ok())
                .unwrap_or_default();
            let saved = store.sessions()?;
            (hidden, saved)
        };
        let saved_ids: HashSet<String> = saved_sessions.iter().map(|session| session.id.clone()).collect();
        let saved_by_native: HashMap<String, &SessionBinding> = saved_sessions.iter()
            .filter(|session| session.native_session_id.is_some())
            .map(|session| (native_session_key(session), session)).collect();
        let normalize = |path: &str| {
            let value = path.replace('\\', "/").trim_end_matches('/').to_string();
            if cfg!(windows) { value.to_lowercase() } else { value }
        };
        let mut state = lock(&self.state);
        let mut changed = false;
        for (cwd, mut binding) in discovered {
            if hidden.contains(&native_session_key(&binding)) { continue; }
            let cwd = normalize(&metadata::display_path(&cwd));
            let workspace = state.workspaces.values().filter_map(|workspace| {
                let root = normalize(&workspace.cwd);
                let matches = cwd == root || (binding.harness_id == "acp:antigravity"
                    && cwd.strip_prefix(&root).is_some_and(|rest| rest.starts_with('/')));
                matches.then_some((root.len(), workspace.id.clone()))
            }).max_by_key(|(length, _)| *length).map(|(_, id)| id);
            let Some(workspace_id) = workspace else { continue };
            binding.workspace_id = workspace_id;
            if let Some(existing) = state.sessions.values_mut().find(|session| {
                session.binding.harness_id == binding.harness_id
                    && ((session.binding.native_session_id.is_some()
                        && session.binding.native_session_id == binding.native_session_id)
                        || (session.binding.native_session_path.is_some()
                            && session.binding.native_session_path == binding.native_session_path))
            }) {
                if existing.instance_id.is_none() && existing.binding.native_session_path != binding.native_session_path {
                    existing.binding.native_session_path = binding.native_session_path.clone();
                    changed = true;
                }
                if existing.instance_id.is_none() && !saved_ids.contains(&existing.binding.id)
                    && (existing.binding.title != binding.title || existing.binding.updated_at != binding.updated_at) {
                    existing.binding.title = binding.title;
                    existing.binding.updated_at = binding.updated_at;
                    changed = true;
                }
                continue;
            }
            if let Some(saved) = saved_by_native.get(&native_session_key(&binding)) {
                binding.id = saved.id.clone();
                binding.title = saved.title.clone();
                binding.pinned = saved.pinned;
                binding.archived = saved.archived;
                binding.read_only = if binding.harness_id == "acp:codex" && saved.imported {
                    false
                } else {
                    saved.read_only
                };
                binding.imported = saved.imported;
                binding.preferences = saved.preferences.clone();
            }
            state.sessions.insert(binding.id.clone(), SessionView::new(binding));
            changed = true;
        }
        let missing: Vec<String> = state.sessions.values().filter(|session| {
            session.instance_id.is_none() && session.binding.native_session_path.as_ref().is_some_and(|path| {
                std::fs::metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            })
        }).map(|session| session.binding.id.clone()).collect();
        for id in missing {
            state.sessions.remove(&id);
            state.dirty.remove(&id);
            state.dirty_messages.remove(&id);
            state.published_messages.remove(&id);
            changed = true;
        }
        state.global_dirty |= changed;
        Ok(())
    }
    pub fn create(&self, workspace_id: &str, harness: &str, title: &str) -> Result<String, String> {
        if !lock(&self.state).workspaces.contains_key(workspace_id) {
            return Err("请先选择工作区".into());
        }
        if !self.harnesses().iter().any(|h| h.id == harness) {
            return Err("代理未注册".into());
        }
        let id = new_id();
        let binding = SessionBinding {
            id: id.clone(),
            workspace_id: workspace_id.into(),
            harness_id: harness.into(),
            title: if title.trim().is_empty() {
                "新会话".into()
            } else {
                title.chars().take(120).collect()
            },
            native_session_id: None,
            native_session_path: None,
            archived: false,
            pinned: false,
            read_only: false,
            imported: false,
            updated_at: now(),
            preferences: SessionPreferences::default(),
        };
        lock(&self.store).save_session(&binding)?;
        let mut state = lock(&self.state);
        state.sessions.insert(id.clone(), SessionView::new(binding));
        state.global_dirty = true;
        Ok(id)
    }
    pub async fn load_history(&self, id: &str, before: Option<usize>) -> Result<Value, String> {
        let view = self.view(id)?;
        let Some(ref path) = view.binding.native_session_path else {
            self.update(id, None, |v| {
                v.history_loaded = true;
                v.history_available = !v.messages.is_empty();
            });
            return Ok(json!({"offset":0}));
        };
        let previous_instance = view.instance_id.clone();
        let previous_revision = view.revision;
        let pi = view.binding.harness_id == "pi";
        let desktop = antigravity_history::is_desktop(&view.binding);
        let indexed_agy = antigravity_history::has_indexed_history(&view.binding);
        let native_id = view.binding.native_session_id.clone();
        let path = PathBuf::from(path);
        let (messages, offset) = tokio::task::spawn_blocking(move || {
            if pi {
                history::read_pi(&path, before)
            } else if indexed_agy {
                let app_dir = if desktop { "antigravity" } else { "antigravity-cli" };
                antigravity_history::read_from(app_dir, native_id.as_deref().ok_or("缺少 Antigravity 会话标识")?, before)
            } else {
                history::read_codex(&path, before)
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        self.update(id, None, |v| {
            if before.is_some()
                || v.instance_id != previous_instance
                || (v.revision != previous_revision && v.busy())
            {
                let mut older = messages;
                older.retain(|m| {
                    !v.messages.iter().any(|live| {
                        live.source_event_id.is_none()
                            && live.role == m.role
                            && live.text == m.text
                            && !m.text.is_empty()
                    })
                });
                older.append(&mut v.messages);
                let mut seen = HashSet::new();
                older.retain(|m| seen.insert(m.id.clone()));
                v.messages = older;
            } else {
                v.messages = messages;
            }
            v.history_loaded = true;
            v.history_available = true;
            v.history_offset = offset;
        });
        Ok(json!({"offset":offset}))
    }
    pub async fn ensure_runtime(self: &Arc<Self>, id: &str) -> Result<Arc<Runtime>, String> {
        self.ensure_runtime_with_policy(id, false).await
    }
    pub(super) async fn ensure_fork_runtime(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<Arc<Runtime>, String> {
        self.ensure_runtime_with_policy(id, true).await
    }
    async fn ensure_runtime_with_policy(
        self: &Arc<Self>,
        id: &str,
        allow_readonly: bool,
    ) -> Result<Arc<Runtime>, String> {
        let _providers = self.provider_gate.read().await;
        self.start_runtime(id, allow_readonly, false).await
    }

    // Provider mutations hold provider_gate write lock across stop, startup and rollback,
    // while independent sessions hold concurrent read locks.
    pub(super) async fn start_runtime(
        self: &Arc<Self>,
        id: &str,
        allow_readonly: bool,
        require_resume: bool,
    ) -> Result<Arc<Runtime>, String> {
        let gate = {
            let mut gates = self.opening.lock().await;
            gates
                .entry(id.into())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _opening = gate.lock().await;
        if let Some(runtime) = lock(&self.runtimes).get(id).cloned() {
            return Ok(runtime);
        }
        let view = self.view(id)?;
        if view.binding.read_only && !allow_readonly {
            return Err("这份原生历史当前只读，请在对应命令行中继续，或新建会话".into());
        }
        let descriptor = self
            .harnesses()
            .into_iter()
            .find(|h| h.id == view.binding.harness_id)
            .ok_or("代理配置不存在")?;
        let mut cwd = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作区不存在")?;
        let (binary, mut args) = registry::launch(&descriptor)?;
        let mut environment = Vec::new();
        let mut agy_temp_dir: Option<PathBuf> = None;
        if descriptor.id == "acp:codex" && super::providers::codex_official_selected(self)? {
            environment.push(("MODEL_PROVIDER", Some("openai".into())));
            environment.push(("OPENAI_BASE_URL", None));
        }
        if descriptor.id == "acp:antigravity" {
            environment = vec![("GEMINI_API_KEY", None), ("GOOGLE_GEMINI_BASE_URL", None)];
            let desktop = antigravity_history::is_desktop(&view.binding);
            let provider = super::providers::agy_for_session(self, id, view.binding.native_session_id.is_some(), desktop)?;
            if let Some(provider) = provider {
                if args.iter().any(|arg| arg.starts_with("--gemini-dir") || arg.starts_with("--gemini_dir")) { return Err("请移除自定义 gemini-dir 后使用第三方供应商".into()); }
                let (extra, env) = super::providers::agy_launch(self, &provider, desktop)?;
                args.extend(extra);
                environment = env;
            }
            environment.push(("AGY_CLI_DISABLE_AUTO_UPDATE", Some("true".into())));
            environment.push(("PYTHONUNBUFFERED", Some("1".into())));
            environment.push(("AGY_ACP_FORCE_FILE_STORAGE", Some("1".into())));
        }
        if antigravity_history::is_desktop(&view.binding) {
            cwd = metadata::display_path(&antigravity_history::desktop_cwd(
                view.binding.native_session_id.as_deref().ok_or("缺少 Antigravity 会话标识")?,
            )?);
            if args.iter().any(|arg| arg.starts_with("--app-data-dir") || arg.starts_with("--app_data_dir")) {
                return Err("请从 Antigravity 代理配置中移除自定义 app-data-dir，以便连接桌面会话".into());
            }
            args.extend(["--app-data-dir".into(), "antigravity".into()]);
        }
        let wire = if descriptor.kind == "nativePi" {
            Wire::Pi
        } else {
            Wire::Acp
        };
        if wire == Wire::Pi {
            args.extend(["--mode".into(), "rpc".into()]);
            let trust = lock(&self.store).preference("trustedPiExtensions")
                .and_then(|value| value.get(&cwd).and_then(Value::as_bool));
            if let Some(trusted) = trust {
                args.push(if trusted { "--approve" } else { "--no-approve" }.into());
            }
            if let Some(path) = &view.binding.native_session_path {
                args.extend(["--session".into(), path.clone()]);
            }
        }
        let instance = new_id();
        if descriptor.id == "acp:antigravity" {
            let short_key: String = instance.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
            let temp_root = std::env::temp_dir().join(format!("cv-agy-{short_key}"));
            if std::fs::create_dir_all(&temp_root).is_ok() {
                let temp_str = temp_root.to_string_lossy().into_owned();
                if cfg!(windows) {
                    environment.push(("TEMP", Some(temp_str.clone())));
                    environment.push(("TMP", Some(temp_str)));
                } else {
                    environment.push(("TMPDIR", Some(temp_str)));
                }
                agy_temp_dir = Some(temp_root);
            }
        }
        self.update(id, None, |v| {
            v.instance_id = Some(instance.clone());
            v.state = "starting".into();
            v.error = None;
            v.commands.clear();
        });
        let spawned = tokio::task::spawn_blocking(move || {
            Bridge::spawn_with_env(&binary, &args, &PathBuf::from(cwd), wire, &environment)
        })
        .await
        .map_err(|e| e.to_string())?;
        let (bridge, mut frames) = match spawned {
            Ok(v) => v,
            Err(e) => {
                if let Some(dir) = agy_temp_dir.take() {
                    let _ = std::fs::remove_dir_all(dir);
                }
                self.update(id, Some(&instance), |v| {
                    v.state = "crashed".into();
                    v.instance_id = None;
                    v.error = Some(e.clone());
                });
                return Err(e);
            }
        };
        if let Some(dir) = agy_temp_dir.take() {
            bridge.set_temp_dir(dir);
        }
        let runtime = Arc::new(Runtime {
            instance: instance.clone(),
            bridge,
            native_id: Mutex::new(view.binding.native_session_id),
            gate: tokio::sync::Mutex::new(()),
            reply_gate: tokio::sync::Mutex::new(()),
            permission_ids: Mutex::new(HashMap::new()),
            fs_approvals: Mutex::new(HashMap::new()),
            session_auto_write: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            loading_history: AtomicBool::new(false),
            loading_desktop_history: AtomicBool::new(false),
            supports_prompt_steer: AtomicBool::new(false),
            active_prompts: AtomicUsize::new(0),
            cancel_seq: AtomicU64::new(0),
            last_activity_ms: AtomicU64::new(now_ms()),
            update_steps_calls: Mutex::new(HashSet::new()),
            pending_config: Mutex::new(PendingRuntimeConfig::default()),
        });
        lock(&self.runtimes).insert(id.into(), runtime.clone());
        let weak = Arc::downgrade(self);
        let sid = id.to_string();
        let run = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                let (Some(host), Some(run)) = (weak.upgrade(), run.upgrade()) else {
                    break;
                };
                if frame.get("type").and_then(Value::as_str) == Some("host_event_barrier") {
                    if let Some(id) = frame.get("id").and_then(Value::as_str) {
                        run.bridge.finish_event_barrier(id);
                    }
                    continue;
                }
                host.handle_frame(&sid, &run, frame);
            }
        });
        let weak = Arc::downgrade(self);
        let sid = id.to_string();
        let run = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(350)).await;
                let (Some(host), Some(run)) = (weak.upgrade(), run.upgrade()) else {
                    break;
                };
                if run.closing.load(std::sync::atomic::Ordering::Acquire) {
                    break;
                }
                match run.bridge.poll_exit() {
                    Ok(None) => {}
                    status => {
                        let diagnostic = run.bridge.diagnostic_tail();
                        let error = format!(
                            "代理进程已退出：{status:?}{}",
                            if diagnostic.is_empty() {
                                String::new()
                            } else {
                                format!("\n{diagnostic}")
                            }
                        );
                        host.runtime_failed(&sid, &run, &error);
                        break;
                    }
                }
            }
        });
        let result = if wire == Wire::Pi {
            self.initialize_pi(id, &runtime).await
        } else {
            self.initialize_acp(id, &runtime, require_resume).await
        };
        if let Err(e) = result {
            self.runtime_failed(id, &runtime, &e);
            return Err(e);
        }
        if let Err(e) = self.apply_pending_config(id, &runtime).await {
            self.update(id, Some(&instance), |v| {
                v.error = Some(e);
            });
        }
        self.update(id, Some(&instance), |v| {
            if v.state == "starting" {
                v.state = "idle".into();
            }
        });
        self.persist(id)?;
        Ok(runtime)
    }
    pub fn runtime_failed(&self, id: &str, runtime: &Arc<Runtime>, error: &str) {
        runtime.closing.store(true, Ordering::Release);
        runtime.cancel_seq.fetch_add(1, Ordering::AcqRel);
        runtime.active_prompts.store(0, Ordering::Release);
        for (_, tx) in lock(&runtime.fs_approvals).drain() {
            let _ = tx.send(false);
        }
        runtime.bridge.close();
        {
            let mut runtimes = lock(&self.runtimes);
            if runtimes
                .get(id)
                .map(|r| r.instance == runtime.instance)
                .unwrap_or(false)
            {
                runtimes.remove(id);
            }
        }
        self.update(id, Some(&runtime.instance), |v| {
            v.state = "crashed".into();
            v.instance_id = None;
            v.error = Some(error.into());
            v.pending_requests.clear();
            v.queue.clear();
            for m in &mut v.messages {
                m.streaming = false;
            }
        });
    }
    pub fn stop_runtime(&self, id: &str) -> Result<(), String> {
        let runtime = lock(&self.runtimes).remove(id);
        if let Some(runtime) = runtime {
            runtime.closing.store(true, Ordering::Release);
            runtime.cancel_seq.fetch_add(1, Ordering::AcqRel);
            runtime.active_prompts.store(0, Ordering::Release);
            for (_, tx) in lock(&runtime.fs_approvals).drain() {
                let _ = tx.send(false);
            }
            runtime.bridge.close();
        }
        self.update(id, None, |v| {
            v.state = "stopped".into();
            v.instance_id = None;
            v.pending_requests.clear();
            v.queue.clear();
            for m in &mut v.messages {
                m.streaming = false;
            }
        });
        Ok(())
    }
    pub fn close_all(&self) {
        let ids = lock(&self.runtimes).keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop_runtime(&id);
        }
        if let Some(remote) = lock(&self.remote).take() {
            let _ = remote.stop.send(());
        }
        self.vcs_watcher.shutdown();
        self.shutdown.notify_waiters();
    }
}
fn remote_harness(harness: &HarnessDescriptor) -> Value {
    json!({"id":harness.id,"displayName":harness.display_name,"kind":harness.kind,"installed":harness.installed,"capabilities":harness.capabilities})
}

pub fn summary(view: &SessionView) -> Value {
    json!({"id":view.binding.id,"workspaceId":view.binding.workspace_id,"harnessId":view.binding.harness_id,"title":view.binding.title,"updatedAt":view.binding.updated_at,"archived":view.binding.archived,"pinned":view.binding.pinned,"readOnly":view.binding.read_only,"imported":view.binding.imported,"instanceId":view.instance_id,"revision":view.revision,"state":view.state,"error":view.error,"preview":view.messages.iter().rev().find(|m|m.kind=="message").map(|m|m.text.chars().take(100).collect::<String>()).unwrap_or_default()})
}
