//! Host-owned state, ordered snapshots and one supervised runtime per session.
use super::{
    bridge::{lock, Bridge, Wire},
    history,
    metadata::{self, MetadataStore},
    protocol::*,
    registry,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

pub struct Runtime {
    pub instance: String,
    pub bridge: Arc<Bridge>,
    pub native_id: Mutex<Option<String>>,
    pub gate: tokio::sync::Mutex<()>,
    pub reply_gate: tokio::sync::Mutex<()>,
    pub permission_ids: Mutex<HashMap<String, Value>>,
    pub fs_approvals: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    pub session_auto_write: std::sync::atomic::AtomicBool,
    pub cancelled: std::sync::atomic::AtomicBool,
    pub closing: std::sync::atomic::AtomicBool,
}
pub struct State {
    pub sequence: u64,
    pub workspaces: BTreeMap<String, Workspace>,
    pub sessions: BTreeMap<String, SessionView>,
    pub dirty: HashSet<String>,
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
                    .map_or(true, |path| PathBuf::from(path).is_file())
            })
            .map(|b| (b.id.clone(), SessionView::new(b)))
            .collect();
        let (events, _) = broadcast::channel(512);
        Ok(Arc::new(Self {
            id: new_id(),
            desktop_token: super::auth::secret(),
            state: Mutex::new(State {
                sequence: 0,
                workspaces,
                sessions,
                dirty: HashSet::new(),
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
    pub fn start_background(self: &Arc<Self>) {
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
    pub fn flush(&self) {
        let mut state = lock(&self.state);
        let ids = state.dirty.drain().collect::<Vec<_>>();
        for id in ids {
            let Some(mut session) = state.sessions.get(&id).cloned() else {
                continue;
            };
            state.sequence += 1;
            let previous = state.published_messages.remove(&id).unwrap_or_default();
            let order = session
                .messages
                .iter()
                .map(|m| m.id.clone())
                .collect::<Vec<_>>();
            let changed = session
                .messages
                .iter()
                .filter(|m| previous.get(&m.id) != Some(*m))
                .cloned()
                .collect::<Vec<_>>();
            state.published_messages.insert(
                id.clone(),
                session
                    .messages
                    .iter()
                    .map(|m| (m.id.clone(), m.clone()))
                    .collect(),
            );
            let summary = summary(&session);
            session.messages.clear();
            let _=self.events.send(Event{protocol_version:PROTOCOL_VERSION,sequence:state.sequence,kind:"session.patch".into(),session_id:Some(id),instance_id:session.instance_id.clone(),payload:json!({"view":session,"messageOrder":order,"messageUpserts":changed,"summary":summary})});
        }
        if state.global_dirty {
            state.global_dirty = false;
            state.sequence += 1;
            let _=self.events.send(Event{protocol_version:PROTOCOL_VERSION,sequence:state.sequence,kind:"host.changed".into(),session_id:None,instance_id:None,payload:json!({"workspaces":state.workspaces.values().collect::<Vec<_>>(),"sessions":state.sessions.values().map(summary).collect::<Vec<_>>(),"harnesses":self.harnesses()})});
        }
    }
    pub fn snapshot(&self) -> Value {
        let state = lock(&self.state);
        json!({"protocolVersion":PROTOCOL_VERSION,"serverId":self.id,"sequence":state.sequence,"workspaces":state.workspaces.values().collect::<Vec<_>>(),"sessions":state.sessions.values().map(summary).collect::<Vec<_>>(),"harnesses":self.harnesses()})
    }

    /// Remote clients get identities and capability flags, never local command lines.
    pub fn snapshot_for(&self, desktop: bool) -> Value {
        if desktop {
            return self.snapshot();
        }
        let state = lock(&self.state);
        json!({"protocolVersion":PROTOCOL_VERSION,"serverId":self.id,"sequence":state.sequence,"workspaces":state.workspaces.values().collect::<Vec<_>>(),"sessions":state.sessions.values().map(summary).collect::<Vec<_>>(),"harnesses":self.harnesses().iter().map(remote_harness).collect::<Vec<_>>()})
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
        if let Some(view) = state.sessions.get_mut(id) {
            if instance.is_some() && view.instance_id.as_deref() != instance {
                return;
            }
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
                if message.arguments.to_string().len() > 128 * 1024 {
                    message.arguments = json!("参数过长，实时视图只展示摘要；原生历史保留完整内容");
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
            state.dirty.insert(id.to_string());
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
        Ok(workspace)
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
        };
        lock(&self.store).save_session(&binding)?;
        let mut state = lock(&self.state);
        state.sessions.insert(id.clone(), SessionView::new(binding));
        state.global_dirty = true;
        Ok(id)
    }
    pub async fn scan_history(self: &Arc<Self>) -> Result<Value, String> {
        let discovered = tokio::task::spawn_blocking(history::discover)
            .await
            .map_err(|e| e.to_string())?;
        let mut state = lock(&self.state);
        let previous_count = state.sessions.len();
        state.sessions.retain(|_, session| {
            session.instance_id.is_some()
                || session
                    .binding
                    .native_session_path
                    .as_ref()
                    .map_or(true, |path| PathBuf::from(path).is_file())
        });
        if state.sessions.len() != previous_count {
            state.global_dirty = true;
        }
        let items: Vec<Value> = discovered
            .into_iter()
            .filter(|item| {
                !state.sessions.values().any(|s| {
                    s.binding.id == item.binding.id
                        || s.binding.native_session_path == item.binding.native_session_path
                })
            })
            .map(|item| {
                json!({
                    "id": item.binding.id,
                    "cwd": item.cwd,
                    "harnessId": item.binding.harness_id,
                    "title": item.binding.title,
                    "readOnly": item.binding.read_only,
                    "updatedAt": item.binding.updated_at,
                })
            })
            .collect();
        Ok(json!({ "total": items.len(), "items": items }))
    }
    pub async fn import_history_selected(
        self: &Arc<Self>,
        selected_ids: Option<HashSet<String>>,
    ) -> Result<Value, String> {
        let discovered = tokio::task::spawn_blocking(history::discover)
            .await
            .map_err(|e| e.to_string())?;
        let mut imported = 0;
        for item in discovered {
            if let Some(ref allow) = selected_ids {
                if !allow.contains(&item.binding.id) {
                    continue;
                }
            }
            if lock(&self.state).sessions.values().any(|s| {
                s.binding.id == item.binding.id
                    || s.binding.native_session_path == item.binding.native_session_path
            }) {
                continue;
            }
            let Ok(workspace) = self.workspace(&item.cwd) else {
                continue;
            };
            let mut binding = item.binding;
            binding.workspace_id = workspace.id;
            lock(&self.store).save_session(&binding)?;
            let mut state = lock(&self.state);
            state
                .sessions
                .insert(binding.id.clone(), SessionView::new(binding));
            imported += 1;
        }
        if imported > 0 {
            lock(&self.state).global_dirty = true;
        }
        Ok(json!({"imported":imported}))
    }
    pub async fn import_history(self: &Arc<Self>) -> Result<Value, String> {
        self.import_history_selected(None).await
    }
    pub async fn load_history(&self, id: &str, before: Option<usize>) -> Result<Value, String> {
        let view = self.view(id)?;
        let Some(path) = view.binding.native_session_path else {
            self.update(id, None, |v| {
                v.history_loaded = true;
                v.history_available = !v.messages.is_empty();
            });
            return Ok(json!({"offset":0}));
        };
        let previous_instance = view.instance_id.clone();
        let previous_revision = view.revision;
        let pi = view.binding.harness_id == "pi";
        let path = PathBuf::from(path);
        let (messages, offset) = tokio::task::spawn_blocking(move || {
            if pi {
                history::read_pi(&path, before)
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
        let cwd = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作区不存在")?;
        let (binary, mut args) = registry::launch(&descriptor)?;
        let wire = if descriptor.kind == "nativePi" {
            Wire::Pi
        } else {
            Wire::Acp
        };
        if wire == Wire::Pi {
            args.extend(["--mode".into(), "rpc".into()]);
            if let Some(path) = &view.binding.native_session_path {
                args.extend(["--session".into(), path.clone()]);
            }
        }
        let instance = new_id();
        self.update(id, None, |v| {
            v.instance_id = Some(instance.clone());
            v.state = "starting".into();
            v.error = None;
        });
        let spawned = tokio::task::spawn_blocking(move || {
            Bridge::spawn(&binary, &args, &PathBuf::from(cwd), wire)
        })
        .await
        .map_err(|e| e.to_string())?;
        let (bridge, mut frames) = match spawned {
            Ok(v) => v,
            Err(e) => {
                self.update(id, Some(&instance), |v| {
                    v.state = "crashed".into();
                    v.error = Some(e.clone());
                });
                return Err(e);
            }
        };
        let runtime = Arc::new(Runtime {
            instance: instance.clone(),
            bridge,
            native_id: Mutex::new(view.binding.native_session_id),
            gate: tokio::sync::Mutex::new(()),
            reply_gate: tokio::sync::Mutex::new(()),
            permission_ids: Mutex::new(HashMap::new()),
            fs_approvals: Mutex::new(HashMap::new()),
            session_auto_write: std::sync::atomic::AtomicBool::new(false),
            cancelled: std::sync::atomic::AtomicBool::new(false),
            closing: std::sync::atomic::AtomicBool::new(false),
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
            self.initialize_acp(id, &runtime).await
        };
        if let Err(e) = result {
            self.runtime_failed(id, &runtime, &e);
            return Err(e);
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
        runtime
            .closing
            .store(true, std::sync::atomic::Ordering::Release);
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
            runtime
                .closing
                .store(true, std::sync::atomic::Ordering::Release);
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
        self.shutdown.notify_waiters();
    }
}
fn remote_harness(harness: &HarnessDescriptor) -> Value {
    json!({"id":harness.id,"displayName":harness.display_name,"kind":harness.kind,"installed":harness.installed,"capabilities":harness.capabilities})
}

pub fn summary(view: &SessionView) -> Value {
    json!({"id":view.binding.id,"workspaceId":view.binding.workspace_id,"harnessId":view.binding.harness_id,"title":view.binding.title,"updatedAt":view.binding.updated_at,"archived":view.binding.archived,"pinned":view.binding.pinned,"readOnly":view.binding.read_only,"imported":view.binding.imported,"instanceId":view.instance_id,"revision":view.revision,"state":view.state,"error":view.error,"preview":view.messages.iter().rev().find(|m|m.kind=="message").map(|m|m.text.chars().take(100).collect::<String>()).unwrap_or_default()})
}
