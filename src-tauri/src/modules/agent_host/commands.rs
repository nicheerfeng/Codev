use super::{
    bridge::{lock, Wire},
    coordinator::{CachedRequest, Host, Runtime},
    protocol::*,
    registry,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
const QUERY: Duration = Duration::from_secs(120);
const INTERACTIVE_PROMPT: Duration = Duration::from_secs(900);

impl Host {
    /// Bounded mutation replay protection, scoped to one authenticated device and host lifetime.
    pub async fn dispatch(
        self: &Arc<Self>,
        principal: &Principal,
        command: Command,
    ) -> Result<Value, String> {
        if command.request_id.is_empty() || command.request_id.len() > 128 {
            return Err("请求标识无效".into());
        }
        if matches!(
            command.operation.as_str(),
            "client.hello"
                | "host.snapshot"
                | "host.resync"
                | "workspace.list"
                | "workspace.skills"
                | "harness.list"
                | "harness.diagnose"
                | "harness.docs.read"
                | "pi.models.read"
                | "pi.assets.list"
                | "harness.assets.list"
                | "harness.providers.list"
                | "host.project_harnesses.get"
                | "host.policy.get"
                | "session.list"
                | "session.open"
                | "runtime.subscribe"
                | "session.history"
                | "session.file.read"
                | "host.remote.status"
                | "host.devices"
        ) {
            return self.execute(principal, command).await;
        }
        let key = format!("{}:{}", principal.id, command.request_id);
        let fingerprint = super::auth::hash(
            &json!([
                command.operation,
                command.session_id,
                command.instance_id,
                command.payload
            ])
            .to_string(),
        );
        let existing = {
            let mut cache = lock(&self.requests);
            if let Some(request) = cache.get(&key) {
                if request.fingerprint != fingerprint {
                    return Err("同一请求标识不能用于不同操作".into());
                }
                Some(request.reply.subscribe())
            } else {
                if cache.len() > 1024 {
                    return Err("请求过多，请稍后重试".into());
                }
                let (tx, _) = tokio::sync::watch::channel(None);
                cache.insert(
                    key.clone(),
                    CachedRequest {
                        fingerprint,
                        reply: tx,
                    },
                );
                None
            }
        };
        if let Some(mut receiver) = existing {
            loop {
                let result = { receiver.borrow().clone() };
                if let Some(result) = result {
                    return result;
                }
                receiver.changed().await.map_err(|_| "原请求已关闭")?;
            }
        }
        let result = self.execute(principal, command).await;
        if let Some(cached) = lock(&self.requests).get(&key) {
            cached.reply.send_replace(Some(result.clone()));
        }
        let mut done = lock(&self.completed);
        done.push_back(key);
        while done.len() > 128 {
            if let Some(key) = done.pop_front() {
                lock(&self.requests).remove(&key);
            }
        }
        result
    }
    async fn execute(
        self: &Arc<Self>,
        principal: &Principal,
        command: Command,
    ) -> Result<Value, String> {
        let operation = command.operation.as_str();
        let payload = &command.payload;
        if let Some(id) = &command.session_id {
            if self.view(id)?.binding.read_only
                && matches!(
                    operation,
                    "session.prompt"
                        | "session.model"
                        | "session.thinking"
                        | "session.config"
                        | "session.compact"
                        | "session.fork"
                )
            {
                return Err("该会话当前只读，不能向原生会话写入操作".into());
            }
        }
        if let Some(id) = &command.session_id {
            if let Some(expected) = &command.instance_id {
                if self.view(id)?.instance_id.as_ref() != Some(expected) {
                    return Err("会话运行实例已变化，请刷新后重试".into());
                }
            }
        }
        match operation {
            "client.hello" | "host.snapshot" | "host.resync" => {
                Ok(self.snapshot_for(principal.desktop))
            }
            "workspace.list" => Ok(json!(lock(&self.state)
                .workspaces
                .values()
                .collect::<Vec<_>>())),
            "workspace.add" => {
                principal.require_desktop()?;
                let workspace = self.workspace(&text(payload, "cwd"))?;
                let host = self.clone();
                tokio::spawn(async move {
                    if let Err(error) = host.refresh_native_history().await {
                        log::warn!("原生会话刷新失败：{error}");
                    }
                });
                Ok(json!(workspace))
            }
            "workspace.sessions.refresh" => {
                self.refresh_native_history().await?;
                Ok(json!({}))
            }
            "workspace.remove" => {
                principal.require_desktop()?;
                let wid = text(payload, "workspaceId");
                let has_busy = lock(&self.state)
                    .sessions
                    .values()
                    .any(|v| v.binding.workspace_id == wid && v.busy());
                if has_busy {
                    return Err("该工作区有正在运行的会话，请先停止".into());
                }
                let ids: Vec<String> = lock(&self.state)
                    .sessions
                    .values()
                    .filter(|v| v.binding.workspace_id == wid)
                    .map(|v| v.binding.id.clone())
                    .collect();
                for sid in &ids {
                    let _ = self.stop_runtime(sid);
                    let _ = lock(&self.store).remove_session(sid);
                }
                lock(&self.store).remove_workspace(&wid)?;
                let mut st = lock(&self.state);
                for sid in &ids {
                    st.sessions.remove(sid);
                    st.published_messages.remove(sid);
                    st.dirty.remove(sid);
                }
                st.workspaces.remove(&wid);
                st.global_dirty = true;
                Ok(json!({}))
            }
            "workspace.skills" => {
                let wid = text(payload, "workspaceId");
                if text(payload, "harnessId") != "acp:antigravity" {
                    return Err("该代理的技能由运行时提供".into());
                }
                let mut cwd = lock(&self.state)
                    .workspaces
                    .get(&wid)
                    .map(|w| w.cwd.clone())
                    .ok_or("工作区不存在")?;
                let session = self.view(command.session_id.as_deref().ok_or("缺少会话标识")?)?;
                if session.binding.workspace_id != wid || session.binding.harness_id != "acp:antigravity" {
                    return Err("技能目录与当前会话不匹配".into());
                }
                if super::antigravity_history::is_desktop(&session.binding) {
                    let native = session.binding.native_session_id.as_deref().ok_or("缺少 Antigravity 会话标识")?;
                    cwd = super::metadata::display_path(&super::antigravity_history::desktop_cwd(native)?);
                }
                let skills = tokio::task::spawn_blocking(move || {
                    let home = dirs::home_dir().unwrap_or_default();
                    let gemini = match std::env::var_os("GEMINI_HOME") {
                        Some(value) if !value.is_empty() => {
                            let path = std::path::PathBuf::from(value);
                            if let Ok(rest) = path.strip_prefix("~") { home.join(rest) } else { path }
                        }
                        _ => home.join(".gemini"),
                    };
                    let cwd = std::path::PathBuf::from(cwd);
                    let roots = [
                        (gemini.join("config/skills"), "全局"),
                        (cwd.join(".gemini/skills"), "项目"),
                        (gemini.join("antigravity-cli/skills"), "CLI"),
                        (cwd.join(".agents/skills"), "项目"),
                    ];
                    let mut list = vec![];
                    let mut seen = std::collections::HashSet::new();
                    for (root, source) in roots {
                        let Ok(entries) = std::fs::read_dir(&root) else {
                            continue;
                        };
                        for entry in entries.flatten() {
                            let skill_md = entry.path().join("SKILL.md");
                            if !skill_md.is_file() {
                                continue;
                            }
                            let directory = entry.file_name().to_string_lossy().into_owned();
                            if directory.starts_with('.') { continue; }
                            let Ok(content) = std::fs::read_to_string(&skill_md) else { continue };
                            let Some(frontmatter) = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n"))
                                .and_then(|body| body.split_once("\n---").map(|(header, _)| header)) else { continue };
                            let Ok(metadata) = serde_yaml::from_str::<serde_yaml::Value>(frontmatter) else { continue };
                            let Some(name) = metadata.get("name").and_then(serde_yaml::Value::as_str)
                                .map(str::trim).filter(|name| !name.is_empty() && !name.chars().any(char::is_whitespace)) else { continue };
                            let description = metadata.get("description").and_then(serde_yaml::Value::as_str).unwrap_or("");
                            if seen.insert(name.to_lowercase()) {
                                list.push(json!({
                                    "name": name,
                                    "description": description,
                                    "path": super::metadata::display_path(&skill_md),
                                    "source": source,
                                }));
                            }
                        }
                    }
                    list
                })
                .await
                .map_err(|e| e.to_string())?;
                Ok(json!({ "skills": skills }))
            }
            "harness.list" => Ok(json!(self.harnesses())),
            "usage.sync" => {
                principal.require_desktop()?;
                let _guard = self.usage_sync.lock().await;
                let directory = self.directory.clone();
                tokio::task::spawn_blocking(move || super::usage::sync(&directory))
                    .await.map_err(|e| e.to_string())?
            }
            "usage.query" => {
                principal.require_desktop()?;
                let directory = self.directory.clone();
                let options = payload.clone();
                tokio::task::spawn_blocking(move || super::usage::query(&directory, &options))
                    .await.map_err(|e| e.to_string())?
            }
            "usage.prices.save" => {
                principal.require_desktop()?;
                super::usage::save_price(&self.directory, payload)
            }
            "pi.models.read" => {
                principal.require_desktop()?;
                super::pi_settings::read_models()
            }
            "pi.version" => {
                principal.require_desktop()?;
                let descriptor = self.harnesses().into_iter().find(|h| h.id == "pi").ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.push("--version".into());
                let version = tokio::task::spawn_blocking(move || super::pi_settings::run_command(&binary, &args, Duration::from_secs(10)))
                    .await.map_err(|e| e.to_string())??;
                Ok(json!({ "version": version }))
            }
            "pi.models.save" => {
                principal.require_desktop()?;
                super::pi_settings::save_models(payload)
            }
            "pi.models.test" => {
                principal.require_desktop()?;
                let provider = text(payload, "provider");
                let model = text(payload, "modelId");
                if provider.is_empty() || model.is_empty() {
                    return Err("请选择已保存的服务商和模型".into());
                }
                let descriptor = self.harnesses().into_iter().find(|h| h.id == "pi").ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.extend(["--mode".into(), "rpc".into(), "--no-session".into(), "--no-tools".into(), "--no-extensions".into(), "--no-skills".into(), "--no-prompt-templates".into(), "--no-context-files".into()]);
                let cwd = super::history::pi_home().filter(|p| p.is_dir())
                    .or_else(dirs::home_dir).ok_or("无法定位工作目录")?;
                let (bridge, mut frames) = tokio::task::spawn_blocking(move || {
                    super::bridge::Bridge::spawn(&binary, &args, &cwd, Wire::Pi)
                }).await.map_err(|e| e.to_string())??;
                let started = std::time::Instant::now();
                let result = tokio::time::timeout(Duration::from_secs(60), async {
                    bridge.request("set_model", json!({"provider": provider, "modelId": model}), QUERY).await?;
                    bridge.request("prompt", json!({"message": "Reply only OK."}), QUERY).await?;
                    let mut received_text = false;
                    while let Some(frame) = frames.recv().await {
                        if frame.get("type").and_then(Value::as_str) == Some("message_end") {
                            if let Some(message) = frame.get("message") {
                                if let Some(error) = message.get("errorMessage").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                                    return Err(error.to_string());
                                }
                                if message.get("role").and_then(Value::as_str) == Some("assistant") {
                                    received_text |= !super::history::content_text(message.get("content").unwrap_or(&Value::Null)).trim().is_empty();
                                }
                            }
                        }
                        if frame.get("type").and_then(Value::as_str) == Some("agent_end") {
                            return if received_text { Ok(()) } else { Err("模型没有返回文本".into()) };
                        }
                    }
                    Err("Pi 测试进程已退出".into())
                }).await;
                bridge.close();
                result.map_err(|_| "模型测试超时".to_string())??;
                Ok(json!({ "elapsedMs": started.elapsed().as_millis() as u64 }))
            }
            "pi.assets.list" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                let cwd = lock(&self.state).workspaces.get(&workspace_id).map(|w| w.cwd.clone());
                super::pi_settings::assets(&text(payload, "kind"), cwd.as_deref())
            }
            "harness.assets.list" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                let cwd = lock(&self.state).workspaces.get(&workspace_id).map(|w| w.cwd.clone());
                let harness = text(payload, "harnessId");
                let kind = text(payload, "kind");
                tokio::task::spawn_blocking(move || match kind.as_str() {
                    "skills" => super::asset_inventory::skills(&harness, cwd.as_deref()),
                    "plugins" => super::asset_inventory::plugins(&harness),
                    _ => Err("不支持的资源类型".into()),
                }).await.map_err(|e| e.to_string())?
            }
            "harness.providers.list" => {
                principal.require_desktop()?;
                super::providers::list(self, &text(payload, "harnessId"))
            }
            "harness.providers.save" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.lock().await;
                super::providers::save(self, &text(payload, "harnessId"), payload)
            }
            "harness.providers.native.save" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.lock().await;
                super::providers::save_codex_native(self, payload)
            }
            "harness.providers.import" | "harness.providers.duplicate" | "harness.providers.discover" => {
                principal.require_desktop()?;
                let harness = text(payload, "harnessId");
                let id = text(payload, "id");
                let host = self.clone();
                let op = operation.to_owned();
                let _gate = if operation == "harness.providers.discover" { None } else { Some(self.provider_gate.lock().await) };
                tokio::task::spawn_blocking(move || super::providers::catalog_action(&host, &harness, &id, &op))
                    .await.map_err(|e| e.to_string())?
            }
            "harness.providers.remove" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.lock().await;
                super::providers::remove(self, &text(payload, "harnessId"), &text(payload, "id"))
            }
            "harness.providers.activate" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.lock().await;
                super::providers::activate(self, &text(payload, "harnessId"), &text(payload, "id")).await
            }
            "harness.providers.reconnect" => {
                principal.require_desktop()?;
                let harness = text(payload, "harnessId");
                let id = text(payload, "id");
                let ids = {
                    let _providers = self.provider_gate.lock().await;
                    super::providers::prepare_reconnect(self, &harness, &id).await?
                };
                let mut failures = Vec::new();
                for id in &ids {
                    if let Err(error) = self.ensure_runtime(id).await { failures.push(format!("{}：{}", self.view(id).map(|v| v.binding.title).unwrap_or_else(|_| id.clone()), error)); }
                }
                if !failures.is_empty() { return Err(format!("配置已保存，但部分线程重新连接失败：{}", failures.join("；"))); }
                Ok(json!({"count": ids.len()}))
            }
            "pi.plugins.install" => {
                principal.require_desktop()?;
                let package = text(payload, "package");
                let allowed = ["pi-mcp-adapter", "pi-lens", "pi-subagents", "@ogulcancelik/pi-codex-subagents", "pi-intercom", "pi-feishu-lark", "pi-hide-providers", "pi-rename-session"];
                if !allowed.contains(&package.as_str()) { return Err("不支持的推荐插件".into()); }
                let descriptor = self.harnesses().into_iter().find(|h| h.id == "pi").ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.extend(["install".into(), format!("npm:{package}")]);
                let message = tokio::task::spawn_blocking(move || super::pi_settings::run_command(&binary, &args, Duration::from_secs(180)))
                    .await.map_err(|e| e.to_string())??;
                Ok(json!({ "message": message }))
            }
            "host.project_harnesses.get" => {
                principal.require_desktop()?;
                Ok(lock(&self.store).preference("projectHarnesses").unwrap_or(Value::Null))
            }
            "host.project_harnesses.set" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                if !lock(&self.state).workspaces.contains_key(&workspace_id) {
                    return Err("工作区不存在".into());
                }
                let ids = payload.get("harnessIds").and_then(Value::as_array).ok_or("缺少代理列表")?;
                let available = self.harnesses();
                if ids.iter().any(|id| !id.as_str().is_some_and(|id| available.iter().any(|h| h.id == id))) {
                    return Err("代理列表包含未注册的代理".into());
                }
                let store = lock(&self.store);
                let mut all = store.preference("projectHarnesses")
                    .and_then(|value| value.as_object().cloned()).unwrap_or_default();
                all.insert(workspace_id, json!(ids));
                store.set_preference("projectHarnesses", &Value::Object(all))?;
                Ok(json!({}))
            }
            "harness.diagnose" => {
                let list = self.harnesses();
                let items = list
                    .iter()
                    .map(registry::diagnose_harness)
                    .collect::<Vec<_>>();
                Ok(json!({ "items": items }))
            }
            "harness.save" => {
                principal.require_desktop()?;
                let descriptor: HarnessDescriptor =
                    serde_json::from_value(payload.clone()).map_err(|e| e.to_string())?;
                registry::validate_descriptor(&descriptor)?;
                if descriptor.id == "pi" && descriptor.kind != "nativePi" {
                    return Err("Pi 必须使用原生协议".into());
                }
                let mut list = self.harnesses();
                if let Some(existing) = list.iter_mut().find(|d| d.id == descriptor.id) {
                    *existing = descriptor;
                } else {
                    list.push(descriptor);
                }
                lock(&self.store).set_preference("harnesses", &json!(list))?;
                lock(&self.state).global_dirty = true;
                Ok(json!({}))
            }
            "harness.delete" => {
                principal.require_desktop()?;
                let id = text(payload, "id");
                if !id.starts_with("acp:custom-") {
                    return Err("内置代理不可删除；若修改过命令可使用“恢复默认”".into());
                }
                let mut list = self.harnesses();
                list.retain(|d| d.id != id);
                lock(&self.store).set_preference("harnesses", &json!(list))?;
                lock(&self.state).global_dirty = true;
                Ok(json!({}))
            }
            "harness.reset" => {
                principal.require_desktop()?;
                let id = text(payload, "id");
                let defaults = registry::defaults();
                let def = defaults
                    .into_iter()
                    .find(|d| d.id == id)
                    .ok_or("仅内置代理支持恢复默认")?;
                let mut list = self.harnesses();
                if let Some(existing) = list.iter_mut().find(|d| d.id == id) {
                    *existing = def;
                }
                lock(&self.store).set_preference("harnesses", &json!(list))?;
                lock(&self.state).global_dirty = true;
                Ok(json!({}))
            }
            "host.policy.get" => {
                let policies = lock(&self.store)
                    .preference("hostToolsPolicy")
                    .unwrap_or_else(|| json!({}));
                let trusted = lock(&self.store)
                    .preference("trustedPiExtensions")
                    .unwrap_or_else(|| json!({}));
                Ok(json!({ "policies": policies, "trustedPiExtensions": trusted }))
            }
            "host.policy.set" => {
                principal.require_desktop()?;
                if let Some(hid) = payload.get("harnessId").and_then(Value::as_str) {
                    let mut policy = self.host_tools_policy(hid);
                    if let Some(read) = payload.get("read").and_then(Value::as_str) {
                        policy.read = read.to_string();
                    }
                    if let Some(write) = payload.get("write").and_then(Value::as_str) {
                        policy.write = write.to_string();
                    }
                    if let Some(permission) = payload.get("permission").and_then(Value::as_str) {
                        policy.permission = permission.to_string();
                    }
                    if let Some(allow_outside) =
                        payload.get("allowOutsideWorkspace").and_then(Value::as_bool)
                    {
                        policy.allow_outside_workspace = allow_outside;
                    }
                    let store = lock(&self.store);
                    let mut all = store
                        .preference("hostToolsPolicy")
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    all.insert(
                        hid.into(),
                        serde_json::to_value(&policy).map_err(|e| e.to_string())?,
                    );
                    store.set_preference("hostToolsPolicy", &Value::Object(all))?;
                }
                if let Some(cwd) = payload.get("trustWorkspaceCwd").and_then(Value::as_str) {
                    let store = lock(&self.store);
                    let mut all = store.preference("trustedPiExtensions")
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    if let Some(trusted) = payload.get("trusted").and_then(Value::as_bool) {
                        all.insert(cwd.into(), json!(trusted));
                    } else {
                        all.remove(cwd);
                    }
                    store.set_preference("trustedPiExtensions", &Value::Object(all))?;
                }
                Ok(json!({}))
            }
            "harness.docs.read" => {
                principal.require_desktop()?;
                let pi_home = super::history::pi_home();
                let pi_append_path = pi_home.as_ref().map(|p| p.join("APPEND_SYSTEM.md"));
                let pi_models_path = pi_home.as_ref().map(|p| p.join("models.json"));
                let codex_agents_path = dirs::home_dir().map(|h| h.join(".codex/AGENTS.md"));
                let antigravity_agents_path = dirs::home_dir().map(|h| h.join(".gemini/AGENTS.md"));
                let read_opt = |p: Option<&std::path::PathBuf>| -> Result<String, String> {
                    let Some(path) = p else { return Ok(String::new()) };
                    match std::fs::read_to_string(path) {
                        Ok(content) => Ok(content),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
                    }
                };
                let pi_models_providers = pi_models_path
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v.get("providers").and_then(|p| p.as_object()).map(|o| o.keys().cloned().collect::<Vec<_>>()))
                    .unwrap_or_default();
                Ok(json!({
                    "piAppendSystemPath": pi_append_path.as_ref().map(|p| super::metadata::display_path(p)).unwrap_or_default(),
                    "piAppendSystem": read_opt(pi_append_path.as_ref())?,
                    "piModelsPath": pi_models_path.as_ref().map(|p| super::metadata::display_path(p)).unwrap_or_default(),
                    "piModelsProviders": pi_models_providers,
                    "codexAgentsPath": codex_agents_path.as_ref().map(|p| super::metadata::display_path(p)).unwrap_or_default(),
                    "codexAgents": read_opt(codex_agents_path.as_ref())?,
                    "antigravityAgentsPath": antigravity_agents_path.as_ref().map(|p| super::metadata::display_path(p)).unwrap_or_default(),
                    "antigravityAgents": read_opt(antigravity_agents_path.as_ref())?,
                }))
            }
            "harness.docs.save" => {
                principal.require_desktop()?;
                let target = text(payload, "target");
                let content = text(payload, "content");
                if content.len() > 256 * 1024 {
                    return Err("配置文本超过 256 KiB 限制".into());
                }
                let path = match target.as_str() {
                    "piAppendSystem" => super::history::pi_home()
                        .map(|p| p.join("APPEND_SYSTEM.md"))
                        .ok_or("找不到 Pi 配置目录")?,
                    "codexAgents" => dirs::home_dir()
                        .map(|h| h.join(".codex/AGENTS.md"))
                        .ok_or("找不到 Codex 主目录")?,
                    "antigravityAgents" => dirs::home_dir()
                        .map(|h| h.join(".gemini/AGENTS.md"))
                        .ok_or("找不到 Antigravity 主目录")?,
                    _ => return Err("不支持的配置文件目标".into()),
                };
                if let Some(expected) = payload.get("expected").and_then(Value::as_str) {
                    let current = match std::fs::read_to_string(&path) {
                        Ok(content) => content,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                        Err(error) => return Err(format!("读取配置失败：{error}")),
                    };
                    if current != expected { return Err("配置文件已被其他程序修改，请重新打开设置后再保存".into()); }
                }
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                    std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| e.to_string())?;
                    file.persist(&path).map_err(|e| e.error.to_string())?;
                } else {
                    return Err("无法定位配置目录".into());
                }
                Ok(json!({ "saved": super::metadata::display_path(&path) }))
            }
            "session.list" => Ok(json!(lock(&self.state)
                .sessions
                .values()
                .map(super::coordinator::summary)
                .collect::<Vec<_>>())),
            "session.create" => {
                let id = self.create(
                    &text(payload, "workspaceId"),
                    &text(payload, "harnessId"),
                    &text(payload, "title"),
                )?;
                if payload
                    .get("connect")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                {
                    self.ensure_runtime(&id).await?;
                }
                Ok(json!(self.view(&id)?))
            }
            "session.open" | "runtime.subscribe" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                if !self.view(id)?.history_loaded && self.view(id)?.instance_id.is_none() {
                    self.load_history(id, None).await?;
                }
                if payload.get("connect").and_then(Value::as_bool) == Some(true) {
                    self.ensure_runtime(id).await?;
                }
                Ok(json!(self.view(id)?))
            }
            "session.history" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.load_history(
                    id,
                    payload
                        .get("before")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize),
                )
                .await?;
                Ok(json!(self.view(id)?))
            }
            "session.connect" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.ensure_runtime(id).await?;
                Ok(json!(self.view(id)?))
            }
            "session.prompt" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.ensure_runtime(id).await?;
                let _gate = self.provider_gate.lock().await;
                self.accept_prompt(id, payload.clone())?;
                Ok(json!({"accepted":true}))
            }
            "session.cancel" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let runtime = lock(&self.runtimes)
                    .get(id)
                    .cloned()
                    .ok_or("会话没有运行")?;
                {
                    let _replies = runtime.reply_gate.lock().await;
                    runtime
                        .cancelled
                        .store(true, std::sync::atomic::Ordering::Release);
                    for (_, tx) in lock(&runtime.fs_approvals).drain() {
                        let _ = tx.send(false);
                    }
                    if runtime.bridge.wire == Wire::Pi {
                        for request in self.view(id)?.pending_requests {
                            let _=runtime.bridge.send(json!({"type":"extension_ui_response","id":request.id,"cancelled":true}));
                        }
                    } else {
                        for (_, native) in lock(&runtime.permission_ids).drain() {
                            let _=runtime.bridge.send(json!({"jsonrpc":"2.0","id":native,"result":{"outcome":{"outcome":"cancelled"}}}));
                        }
                    }
                    self.update(id, Some(&runtime.instance), |v| {
                        v.state = "stopping".into();
                        v.queue.clear();
                        v.pending_requests.clear();
                    });
                }
                let result = if runtime.bridge.wire == Wire::Pi {
                    runtime
                        .bridge
                        .request("abort", json!({}), QUERY)
                        .await
                        .map(|_| ())
                } else {
                    let native = lock(&runtime.native_id).clone();
                    runtime.bridge.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":native}}))
                };
                if let Err(e) = result {
                    self.update(id, Some(&runtime.instance), |v| {
                        v.error = Some(e.clone());
                        v.state = "idle".into();
                    });
                    return Err(e);
                }
                if runtime.bridge.wire == Wire::Pi {
                    self.update(id, Some(&runtime.instance), |v| {
                        if v.state == "stopping" {
                            v.state = "idle".into();
                        }
                    });
                    self.turn_finished(id, &runtime);
                }
                Ok(json!({}))
            }
            "session.queue.clear" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.update(id, None, |v| v.queue.clear());
                Ok(json!({}))
            }
            "session.queue.remove" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let idx = payload.get("index").and_then(Value::as_u64).map(|n| n as usize);
                let qid = text(payload, "id");
                self.update(id, None, |v| {
                    if !qid.is_empty() {
                        v.queue.retain(|item| text(item, "id") != qid);
                    } else if let Some(i) = idx.filter(|i| *i < v.queue.len()) {
                        v.queue.remove(i);
                    }
                });
                Ok(json!({}))
            }
            "session.queue.update" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let next_text = text(payload, "text");
                if next_text.trim().is_empty() {
                    return Err("内容不能为空".into());
                }
                let idx = payload.get("index").and_then(Value::as_u64).map(|n| n as usize);
                let qid = text(payload, "id");
                self.update(id, None, |v| {
                    let target = if !qid.is_empty() {
                        v.queue.iter_mut().find(|item| text(item, "id") == qid)
                    } else {
                        idx.and_then(|i| v.queue.get_mut(i))
                    };
                    if let Some(item) = target {
                        if let Some(obj) = item.as_object_mut() {
                            obj.insert("text".into(), json!(next_text));
                        }
                    }
                });
                Ok(json!({}))
            }
            "session.queue.move" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let from = payload.get("from").and_then(Value::as_u64).unwrap_or(0) as usize;
                let to = payload.get("to").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.update(id, None, |v| {
                    if from < v.queue.len() && to < v.queue.len() && from != to {
                        let item = v.queue.remove(from);
                        v.queue.insert(to, item);
                    }
                });
                Ok(json!({}))
            }
            "session.queue.steer" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let idx = payload.get("index").and_then(Value::as_u64).map(|n| n as usize);
                let qid = text(payload, "id");
                let mut extracted: Option<Value> = None;
                self.update(id, None, |v| {
                    let pos = if !qid.is_empty() {
                        v.queue.iter().position(|item| text(item, "id") == qid)
                    } else {
                        idx.filter(|i| *i < v.queue.len())
                    };
                    if let Some(i) = pos {
                        extracted = Some(v.queue.remove(i));
                    }
                });
                let Some(mut item) = extracted else {
                    return Err("排队消息不存在".into());
                };
                let active_runtime = { lock(&self.runtimes).get(id).cloned() };
                if let Some(runtime) = active_runtime {
                    if runtime.bridge.wire == Wire::Pi {
                        let msg_text = text(&item, "text");
                        let imgs = item
                            .get("images")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        runtime
                            .bridge
                            .request(
                                "steer",
                                json!({ "message": msg_text, "images": imgs }),
                                INTERACTIVE_PROMPT,
                            )
                            .await?;
                        self.update(id, Some(&runtime.instance), |v| {
                            v.messages.push(Message {
                                id: new_id(),
                                kind: "message".into(),
                                role: "user".into(),
                                text: msg_text,
                                images: imgs,
                                status: "completed".into(),
                                created_at: now_ms(),
                                raw_kind: "pending_user_echo".into(),
                                ..Message::default()
                            });
                        });
                        return Ok(json!({ "steered": true }));
                    }
                }
                self.update(id, None, |v| {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("steer".into(), json!(true));
                    }
                    v.queue.insert(0, item);
                });
                Ok(json!({ "prioritized": true }))
            }
            "session.close" => {
                principal.require_desktop()?;
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                if self.view(id)?.busy()
                    && payload.get("force").and_then(Value::as_bool) != Some(true)
                {
                    return Err("运行中不能关闭进程，请先停止，或明确选择强制断开".into());
                }
                self.stop_runtime(id)?;
                Ok(json!({}))
            }
            "session.rename" | "session.archive" | "session.pin" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let view = self.view(id)?;
                if operation == "session.archive" && view.busy() {
                    return Err("运行中的会话不能归档".into());
                }
                if operation == "session.rename" {
                    let title = text(payload, "title")
                        .trim()
                        .chars()
                        .take(160)
                        .collect::<String>();
                    if title.is_empty() {
                        return Err("标题不能为空".into());
                    }
                    let runtime = { lock(&self.runtimes).get(id).cloned() };
                    if let Some(r) = runtime {
                        if r.bridge.wire == Wire::Pi && !view.binding.read_only {
                            r.bridge
                                .request("set_session_name", json!({"name":title}), QUERY)
                                .await?;
                        }
                    }
                    self.update(id, None, |v| v.binding.title = title);
                } else if operation == "session.pin" {
                    self.update(id, None, |v| {
                        v.binding.pinned = payload
                            .get("value")
                            .and_then(Value::as_bool)
                            .unwrap_or(!view.binding.pinned)
                    });
                } else {
                    self.update(id, None, |v| {
                        v.binding.archived = payload
                            .get("value")
                            .and_then(Value::as_bool)
                            .unwrap_or(!view.binding.archived)
                    });
                }
                self.persist(id)?;
                Ok(json!(self.view(id)?))
            }
            "session.discard_empty" => {
                principal.require_desktop()?;
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let view = self.view(id)?;
                if view.busy() {
                    return Err("运行中的会话不能清理".into());
                }
                if view.binding.imported || view.messages.iter().any(|message| message.role == "user") {
                    return Err("只能清理未发送消息的新会话".into());
                }
                let _refresh = self.native_refresh.lock().await;
                self.stop_runtime(id)?;
                lock(&self.store).remove_session(id)?;
                let mut st = lock(&self.state);
                st.sessions.remove(id);
                st.published_messages.remove(id);
                st.dirty.remove(id);
                st.global_dirty = true;
                Ok(json!({"discarded":true}))
            }
            "session.file.read" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.agent_file(id, payload, false).await
            }
            "session.model" | "session.thinking" | "session.config" | "session.compact"
            | "session.commands" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let runtime = self.ensure_runtime(id).await?;
                if matches!(
                    operation,
                    "session.model" | "session.thinking" | "session.config"
                ) {
                    let view = self.view(id)?;
                    if view.busy() {
                        self.queue_session_setting(id, &runtime, operation, payload)?;
                        let _ = self.save_setting_preference(id, runtime.bridge.wire, &view, operation, payload, true);
                        let updated = self.view(id)?;
                        return Ok(json!({
                            "deferred": true,
                            "model": updated.model,
                            "thinkingLevel": updated.thinking_level,
                        }));
                    }
                }
                let _gate = runtime.gate.lock().await;
                let view = self.view(id)?;
                if view.busy() {
                    if matches!(
                        operation,
                        "session.model" | "session.thinking" | "session.config"
                    ) {
                        self.queue_session_setting(id, &runtime, operation, payload)?;
                        let _ = self.save_setting_preference(id, runtime.bridge.wire, &view, operation, payload, true);
                        let updated = self.view(id)?;
                        return Ok(json!({
                            "deferred": true,
                            "model": updated.model,
                            "thinkingLevel": updated.thinking_level,
                        }));
                    }
                    return Err("当前会话正在运行，请稍后更改配置".into());
                }
                let result = self.apply_session_setting(id, &runtime, operation, payload).await?;
                if matches!(
                    operation,
                    "session.model" | "session.thinking" | "session.config"
                ) {
                    let _ = self.save_setting_preference(id, runtime.bridge.wire, &view, operation, payload, true);
                }
                Ok(result)
            }
            "session.fork" => {
                principal.require_desktop()?;
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let source = self.view(id)?;
                if source.binding.harness_id != "pi" || source.busy() {
                    return Err("请在空闲的 Pi 会话中分叉".into());
                }
                if source.binding.native_session_path.is_none()
                    || !source
                        .messages
                        .iter()
                        .any(|m| m.role == "user" || m.role == "assistant")
                {
                    return Err("会话尚未写入可分叉的原生消息".into());
                }
                let entry_id = payload
                    .get("entryId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let title = format!("{} · 分叉", source.binding.title);
                let next = self.create(&source.binding.workspace_id, "pi", &title)?;
                // The provisional binding must remain read-only until Pi confirms a NEW file.
                self.update(&next, None, |v| {
                    v.binding.native_session_path = source.binding.native_session_path.clone();
                    v.binding.read_only = true;
                });
                self.persist(&next)?;
                let cleanup_failed_fork = |next_id: &str| {
                    let _ = self.stop_runtime(next_id);
                    let mut st = lock(&self.state);
                    st.sessions.remove(next_id);
                    st.published_messages.remove(next_id);
                    st.dirty.remove(next_id);
                    st.global_dirty = true;
                    let _ = lock(&self.store).remove_session(next_id);
                };
                let runtime = match self.ensure_fork_runtime(&next).await {
                    Ok(rt) => rt,
                    Err(error) => {
                        cleanup_failed_fork(&next);
                        return Err(error);
                    }
                };
                let _gate = runtime.gate.lock().await;
                let (rpc_method, rpc_params) = if let Some(ref eid) = entry_id {
                    ("fork", json!({ "entryId": eid }))
                } else {
                    ("clone", json!({}))
                };
                let cloned = runtime
                    .bridge
                    .request(rpc_method, rpc_params, QUERY)
                    .await
                    .and_then(|result| {
                        if result.get("cancelled") == Some(&json!(true)) {
                            Err("Pi 已取消分叉".into())
                        } else {
                            Ok(result)
                        }
                    });
                let prepared = match cloned {
                    Ok(_) => self.refresh_pi(&next, &runtime, true).await,
                    Err(e) => Err(e),
                };
                if let Err(error) = prepared {
                    drop(_gate);
                    cleanup_failed_fork(&next);
                    return Err(error);
                }
                let new_path = self.view(&next)?.binding.native_session_path;
                if new_path.is_none() || new_path == source.binding.native_session_path {
                    drop(_gate);
                    cleanup_failed_fork(&next);
                    return Err("Pi 没有生成独立会话，分叉已撤销".into());
                }
                runtime
                    .bridge
                    .request("set_session_name", json!({"name":title}), QUERY)
                    .await?;
                self.update(&next, Some(&runtime.instance), |v| {
                    v.binding.read_only = false;
                    v.binding.title = title;
                });
                self.persist(&next)?;
                Ok(json!(self.view(&next)?))
            }
            "permission.respond" | "extension.respond" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let runtime = lock(&self.runtimes)
                    .get(id)
                    .cloned()
                    .ok_or("代理已经退出")?;
                let _gate = runtime.reply_gate.lock().await;
                let request_id = text(payload, "id");
                let pending = self
                    .view(id)?
                    .pending_requests
                    .into_iter()
                    .find(|p| p.id == request_id)
                    .ok_or("该请求已处理或已失效")?;
                if runtime.bridge.wire == Wire::Pi {
                    let cancelled = payload
                        .get("cancelled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    runtime.bridge.send(json!({"type":"extension_ui_response","id":request_id,"value":payload.get("value"),"confirmed":payload.get("confirmed"),"cancelled":cancelled}))?;
                } else if request_id.starts_with("fs-write:") {
                    let option = text(payload, "optionId");
                    let approved = match option.as_str() {
                        "allow_once" => true,
                        "allow_session" => {
                            runtime
                                .session_auto_write
                                .store(true, std::sync::atomic::Ordering::Release);
                            true
                        }
                        _ => false,
                    };
                    if let Some(tx) = lock(&runtime.fs_approvals).remove(&request_id) {
                        let _ = tx.send(approved);
                    }
                } else {
                    let option = text(payload, "optionId");
                    if !option.is_empty()
                        && !pending
                            .options
                            .iter()
                            .any(|o| text(o, "optionId") == option)
                    {
                        return Err("审批选项已失效".into());
                    }
                    let native = lock(&runtime.permission_ids)
                        .remove(&request_id)
                        .ok_or("审批已处理")?;
                    let outcome = if option.is_empty() {
                        json!({"outcome":"cancelled"})
                    } else {
                        json!({"outcome":"selected","optionId":option})
                    };
                    runtime
                        .bridge
                        .send(json!({"jsonrpc":"2.0","id":native,"result":{"outcome":outcome}}))?;
                }
                self.update(id, Some(&runtime.instance), |v| {
                    v.pending_requests.retain(|p| p.id != request_id)
                });
                Ok(json!({}))
            }
            "host.remote.status" => {
                principal.require_desktop()?;
                Ok(self.remote_status())
            }
            "host.remote.enable" => {
                principal.require_desktop()?;
                let port = payload.get("port").and_then(Value::as_u64).unwrap_or(7331);
                if !(1..=65535).contains(&port) {
                    return Err("端口必须在 1–65535 之间".into());
                }
                self.enable_remote(port as u16).await
            }
            "host.remote.disable" => {
                principal.require_desktop()?;
                self.disable_remote();
                Ok(self.remote_status())
            }
            "host.pair.start" => {
                principal.require_desktop()?;
                self.begin_pairing()
            }
            "host.devices" => {
                principal.require_desktop()?;
                let devices = lock(&self.store).devices()?;
                let pending = lock(&self.auth).pending_list();
                Ok(json!({"devices":devices,"pending":pending}))
            }
            "host.device.approve" | "host.device.deny" => {
                principal.require_desktop()?;
                self.decide_device(&text(payload, "id"), operation == "host.device.approve")
            }
            "host.device.revoke" => {
                principal.require_desktop()?;
                lock(&self.store).revoke_device(&text(payload, "id"))?;
                Ok(json!({}))
            }
            _ => Err(format!("不支持的主机操作：{operation}")),
        }
    }
    pub fn accept_prompt(self: &Arc<Self>, id: &str, payload: Value) -> Result<(), String> {
        let runtime = lock(&self.runtimes).get(id).cloned().ok_or("代理未连接")?;
        let _gate = runtime
            .gate
            .try_lock()
            .map_err(|_| "正在应用会话配置，请稍后发送")?;
        let text = text(&payload, "text");
        let images = payload
            .get("images")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if text.trim().is_empty() && images.is_empty() {
            return Err("消息不能为空".into());
        }
        if text.len() > 1024 * 1024 || images.len() > 4 {
            return Err("每条消息最多 1 MiB 文字、4 张图片".into());
        }
        if images
            .iter()
            .filter_map(|v| v.get("data").and_then(Value::as_str))
            .map(str::len)
            .sum::<usize>()
            > 12 * 1024 * 1024
        {
            return Err("图片合计超过消息大小限制，请减少图片后发送".into());
        }
        if images.iter().any(|v| {
            !matches!(
                v.get("mimeType").and_then(Value::as_str),
                Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
            ) || v
                .get("data")
                .and_then(Value::as_str)
                .map(|s| s.len() > 5 * 1024 * 1024)
                .unwrap_or(true)
        }) {
            return Err("图片类型无效或单张图片超过限制".into());
        }
        {
            let mut state = lock(&self.state);
            let view = state.sessions.get_mut(id).ok_or("会话不存在")?;
            if view.binding.read_only {
                return Err("此历史当前只读".into());
            }
            if !images.is_empty() && !view.capabilities.supports_images {
                return Err("当前代理没有声明图片能力".into());
            }
            if view.busy() {
                let mut item = payload;
                if let Some(obj) = item.as_object_mut() {
                    obj.entry("id").or_insert_with(|| json!(new_id()));
                }
                if item.get("steer").and_then(Value::as_bool) == Some(true)
                    && runtime.bridge.wire == Wire::Pi
                {
                    let runtime_cloned = runtime.clone();
                    let host_cloned = self.clone();
                    let sid = id.to_string();
                    let msg_text = text.clone();
                    let imgs = images.clone();
                    tokio::spawn(async move {
                        let _ = runtime_cloned
                            .bridge
                            .request(
                                "steer",
                                json!({ "message": msg_text, "images": imgs }),
                                INTERACTIVE_PROMPT,
                            )
                            .await;
                        host_cloned.update(&sid, Some(&runtime_cloned.instance), |v| {
                            v.messages.push(Message {
                                id: new_id(),
                                kind: "message".into(),
                                role: "user".into(),
                                text: msg_text,
                                images: imgs,
                                status: "completed".into(),
                                created_at: now_ms(),
                                raw_kind: "pending_user_echo".into(),
                                ..Message::default()
                            });
                        });
                    });
                    return Ok(());
                }
                if item.get("queue").and_then(Value::as_bool) == Some(true)
                    && view.capabilities.supports_queue
                {
                    if view.queue.len() >= 20 {
                        return Err("队列最多 20 条消息".into());
                    }
                    if view
                        .queue
                        .iter()
                        .map(|p| p.to_string().len())
                        .sum::<usize>()
                        + item.to_string().len()
                        > 32 * 1024 * 1024
                    {
                        return Err("图片队列已满，请等待先前消息发送".into());
                    }
                    if item.get("steer").and_then(Value::as_bool) == Some(true) {
                        view.queue.insert(0, item);
                    } else {
                        view.queue.push(item);
                    }
                    view.revision += 1;
                    state.dirty.insert(id.into());
                    return Ok(());
                }
                return Err("会话正在运行，请加入队列或先停止".into());
            }
            view.state = "working".into();
            view.binding.archived = false;
            view.error = None;
            view.revision += 1;
            state.dirty.insert(id.into());
        }
        self.schedule_prompt(id.into(), payload);
        Ok(())
    }
    pub fn schedule_prompt(self: &Arc<Self>, id: String, payload: Value) {
        let host = self.clone();
        let instance = self.view(&id).ok().and_then(|v| v.instance_id);
        tokio::spawn(async move {
            if let Err(error) = host.prompt_now(&id, payload).await {
                host.update(&id, instance.as_deref(), |v| {
                    if !error.ends_with("响应超时") {
                        v.state = "idle".into();
                        for m in &mut v.messages {
                            m.streaming = false;
                        }
                    }
                    v.error = Some(error.clone());
                });
            }
        });
    }
    fn acp_setting_kind(view: &SessionView, operation: &str, payload: &Value) -> Result<(String, String), String> {
        if operation == "session.commands" {
            return Ok((String::new(), String::new()));
        }
        let config_id = if operation == "session.model" {
            view.config_options
                .iter()
                .find(|c| text(c, "category") == "model" || text(c, "id") == "model")
                .map(|c| text(c, "id"))
                .unwrap_or_default()
        } else if operation == "session.thinking" {
            view.config_options
                .iter()
                .find(|c| {
                    matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                        || text(c, "id").contains("thinking")
                        || text(c, "id") == "thought_level"
                })
                .map(|c| text(c, "id"))
                .unwrap_or_default()
        } else {
            text(payload, "configId")
        };
        let value = if operation == "session.model" {
            text(payload, "modelId")
        } else if operation == "session.thinking" {
            text(payload, "level")
        } else {
            text(payload, "value")
        };
        if config_id.is_empty() && operation == "session.model" {
            return Ok(("__model__".into(), value));
        }
        if config_id.is_empty() {
            return Err("该代理没有声明此配置选项".into());
        }
        if !view.config_options.iter().any(|c| text(c, "id") == config_id) {
            return Err("该代理没有声明此配置选项".into());
        }
        Ok((config_id, value))
    }

    pub(super) fn queue_session_setting(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        operation: &str,
        payload: &Value,
    ) -> Result<(), String> {
        let view = self.view(id)?;
        if runtime.bridge.wire == Wire::Pi {
            let mut pending = lock(&runtime.pending_config);
            match operation {
                "session.model" => {
                    let provider = text(payload, "provider");
                    let model = text(payload, "modelId");
                    if !view.models.iter().any(|m| {
                        text(m, "provider") == provider && text(m, "id") == model
                    }) {
                        return Err("模型不在当前 Pi 运行时清单中".into());
                    }
                    pending.model = Some((provider, model));
                }
                "session.thinking" => {
                    let level = text(payload, "level");
                    if !view.thinking_levels.contains(&level) {
                        return Err("该模型不支持此思考等级".into());
                    }
                    pending.thinking = Some(level);
                }
                _ => return Err("Pi 使用原生模型和思考等级设置".into()),
            }
            let snapshot = pending.clone();
            drop(pending);
            self.update(id, Some(&runtime.instance), |v| snapshot.overlay_on_view(v));
            return Ok(());
        }
        let (config_id, value) = Self::acp_setting_kind(&view, operation, payload)?;
        let mut pending = lock(&runtime.pending_config);
        let is_model = operation == "session.model"
            || config_id == "__model__"
            || view
                .config_options
                .iter()
                .any(|c| text(c, "id") == config_id && (text(c, "category") == "model" || text(c, "id") == "model"));
        let is_thinking = !is_model
            && (operation == "session.thinking"
                || view.config_options.iter().any(|c| {
                    text(c, "id") == config_id
                        && (matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                            || text(c, "id").contains("thinking")
                            || text(c, "id") == "thought_level")
                }));
        if is_model {
            let provider = text(payload, "provider");
            pending.model = Some((
                if provider.is_empty() {
                    view.binding.harness_id.clone()
                } else {
                    provider
                },
                value,
            ));
        } else if is_thinking {
            pending.thinking = Some(value);
        } else {
            pending.set_config(config_id, value);
        }
        let snapshot = pending.clone();
        drop(pending);
        self.update(id, Some(&runtime.instance), |v| snapshot.overlay_on_view(v));
        Ok(())
    }

    pub(super) async fn apply_session_setting(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        operation: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        if runtime.bridge.wire == Wire::Pi {
            let (method, params) = match operation {
                "session.model" => {
                    let provider = text(payload, "provider");
                    let model = text(payload, "modelId");
                    if !self.view(id)?.models.iter().any(|m| {
                        text(m, "provider") == provider && text(m, "id") == model
                    }) {
                        return Err("模型不在当前 Pi 运行时清单中".into());
                    }
                    lock(&runtime.pending_config).model = None;
                    ("set_model", json!({"provider":provider,"modelId":model}))
                }
                "session.thinking" => {
                    let level = text(payload, "level");
                    if !self.view(id)?.thinking_levels.contains(&level) {
                        return Err("该模型不支持此思考等级".into());
                    }
                    lock(&runtime.pending_config).thinking = None;
                    ("set_thinking_level", json!({"level":level}))
                }
                "session.compact" => (
                    "compact",
                    json!({"customInstructions":payload.get("instructions")}),
                ),
                "session.commands" => ("get_commands", json!({})),
                _ => return Err("Pi 使用原生模型和思考等级设置".into()),
            };
            if operation == "session.compact" {
                self.update(id, Some(&runtime.instance), |v| {
                    v.state = "compacting".into()
                });
            }
            let result = runtime
                .bridge
                .request(
                    method,
                    params,
                    if operation == "session.compact" {
                        Duration::from_secs(3600)
                    } else {
                        QUERY
                    },
                )
                .await;
            if operation == "session.compact" {
                self.update(id, Some(&runtime.instance), |v| v.state = "idle".into());
            }
            let result = result?;
            self.refresh_pi(id, runtime, operation == "session.compact")
                .await?;
            if operation == "session.model" {
                Ok(json!({"model":self.view(id)?.model}))
            } else {
                Ok(result)
            }
        } else {
            if operation == "session.compact" {
                return Err("该代理没有声明压缩能力".into());
            }
            let view = self.view(id)?;
            if operation == "session.commands" {
                return Ok(json!(view.commands));
            }
            let (config_id, value) = Self::acp_setting_kind(&view, operation, payload)?;
            if config_id == "__model__" {
                lock(&runtime.pending_config).model = None;
                let native = lock(&runtime.native_id).clone();
                let result = runtime
                    .bridge
                    .request(
                        "session/set_model",
                        json!({"sessionId":native,"modelId":value}),
                        QUERY,
                    )
                    .await?;
                self.update(id, Some(&runtime.instance), |v| {
                    v.model = v.models.iter().find(|m| text(m, "id") == value).cloned()
                });
                return Ok(result);
            }
            {
                let mut pending = lock(&runtime.pending_config);
                if operation == "session.model" {
                    pending.model = None;
                } else if operation == "session.thinking" {
                    pending.thinking = None;
                } else {
                    pending.configs.retain(|(cid, _)| cid != &config_id);
                }
            }
            self.set_acp_config(id, runtime, &config_id, &value).await
        }
    }

    pub(super) fn save_setting_preference(
        &self,
        id: &str,
        wire: Wire,
        view: &SessionView,
        operation: &str,
        payload: &Value,
        save_harness: bool,
    ) -> Result<(), String> {
        if wire == Wire::Pi {
            return match operation {
                "session.model" => {
                    let provider = text(payload, "provider");
                    let model = text(payload, "modelId");
                    self.record_session_preference(id, save_harness, |prefs| {
                        prefs.model_provider = (!provider.is_empty()).then(|| provider.clone());
                        prefs.model_id = (!model.is_empty()).then(|| model.clone());
                    })
                }
                "session.thinking" => {
                    let level = text(payload, "level");
                    self.record_session_preference(id, save_harness, |prefs| {
                        prefs.thinking_level = (!level.is_empty()).then(|| level.clone());
                    })
                }
                _ => Ok(()),
            };
        }
        let (config_id, value) = Self::acp_setting_kind(view, operation, payload)?;
        let is_model = operation == "session.model"
            || config_id == "__model__"
            || view
                .config_options
                .iter()
                .any(|c| text(c, "id") == config_id && (text(c, "category") == "model" || text(c, "id") == "model"));
        let is_thinking = !is_model
            && (operation == "session.thinking"
                || view.config_options.iter().any(|c| {
                    text(c, "id") == config_id
                        && (matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                            || text(c, "id").contains("thinking")
                            || text(c, "id") == "thought_level")
                }));
        if is_model {
            let provider = text(payload, "provider");
            return self.record_session_preference(id, save_harness, |prefs| {
                prefs.model_id = (!value.is_empty()).then(|| value.clone());
                prefs.model_provider = if !provider.is_empty() {
                    Some(provider.clone())
                } else {
                    Some(view.binding.harness_id.clone())
                };
            });
        }
        if is_thinking {
            return self.record_session_preference(id, save_harness, |prefs| {
                prefs.thinking_level = (!value.is_empty()).then(|| value.clone());
            });
        }
        self.record_session_preference(id, save_harness, |prefs| {
            if value.is_empty() {
                prefs.configs.remove(&config_id);
            } else {
                prefs.configs.insert(config_id.clone(), value.clone());
            }
        })
    }

    pub async fn apply_pending_config(&self, id: &str, runtime: &Arc<Runtime>) -> Result<(), String> {
        let pending = std::mem::take(&mut *lock(&runtime.pending_config));
        if pending.is_empty() {
            return Ok(());
        }
        if let Some((provider, model_id)) = pending.model {
            self.apply_session_setting(
                id,
                runtime,
                "session.model",
                &json!({ "provider": provider, "modelId": model_id }),
            )
            .await?;
        }
        if let Some(level) = pending.thinking {
            self.apply_session_setting(
                id,
                runtime,
                "session.thinking",
                &json!({ "level": level }),
            )
            .await?;
        }
        for (config_id, value) in pending.configs {
            self.apply_session_setting(
                id,
                runtime,
                "session.config",
                &json!({ "configId": config_id, "value": value }),
            )
            .await?;
        }
        Ok(())
    }

    async fn prompt_now(self: &Arc<Self>, id: &str, payload: Value) -> Result<(), String> {
        let runtime = {
            lock(&self.runtimes)
                .get(id)
                .cloned()
                .ok_or("代理已断开，请重新连接")?
        };
        let message = text(&payload, "text");
        let images = payload
            .get("images")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.update(id, Some(&runtime.instance), |v| {
            v.state = "working".into();
            v.error = None;
            for m in &mut v.messages {
                m.streaming = false;
            }
            if v.binding.title == "新会话" {
                v.binding.title = message.chars().take(60).collect();
            }
            v.messages.push(Message {
                id: new_id(),
                kind: "message".into(),
                role: "user".into(),
                text: message.clone(),
                images: images.clone(),
                status: "completed".into(),
                created_at: now_ms(),
                raw_kind: "pending_user_echo".into(),
                ..Message::default()
            });
        });
        runtime
            .cancelled
            .store(false, std::sync::atomic::Ordering::Release);
        self.persist(id)?;
        {
            let _gate = runtime.gate.lock().await;
            self.apply_pending_config(id, &runtime).await?;
        }
        if let Ok(snapshot) = self.view(id) {
            if !snapshot.binding.read_only {
                let model_id = snapshot.model.as_ref().map(|m| text(m, "id")).filter(|s| !s.is_empty());
                let model_provider = snapshot
                    .model
                    .as_ref()
                    .map(|m| text(m, "provider"))
                    .filter(|s| !s.is_empty());
                let thinking = (!snapshot.thinking_level.is_empty()).then(|| snapshot.thinking_level.clone());
                let mode_val = snapshot
                    .config_options
                    .iter()
                    .find(|c| text(c, "id") == "$mode" || text(c, "category") == "mode")
                    .and_then(|c| {
                        let cid = text(c, "id");
                        let val = text(c, "currentValue");
                        (!cid.is_empty() && !val.is_empty()).then_some((cid, val))
                    });
                let _ = self.record_session_preference(id, false, |prefs| {
                    if prefs.model_id.is_none() {
                        prefs.model_id = model_id.clone();
                        prefs.model_provider = model_provider.clone();
                    }
                    if prefs.thinking_level.is_none() {
                        prefs.thinking_level = thinking.clone();
                    }
                    if let Some((ref cid, ref val)) = mode_val {
                        prefs.configs.entry(cid.clone()).or_insert_with(|| val.clone());
                    }
                });
            }
        }
        if runtime.bridge.wire == Wire::Pi {
            let reply = runtime
                .bridge
                .request(
                    "prompt",
                    json!({"message":message,"images":images}),
                    INTERACTIVE_PROMPT,
                )
                .await?;
            if reply.get("disposition").and_then(Value::as_str) == Some("handled") {
                let state = runtime.bridge.request("get_state", json!({}), QUERY).await?;
                if state.get("isStreaming") != Some(&json!(true)) && state.get("isCompacting") != Some(&json!(true)) {
                    self.update(id, Some(&runtime.instance), |v| {
                        if v.state == "working" { v.state = "idle".into(); }
                    });
                    self.turn_finished(id, &runtime);
                }
            }
        } else {
            let native = lock(&runtime.native_id).clone().ok_or("代理尚未初始化")?;
            let mut prompt = vec![json!({"type":"text","text":message})];
            for image in images {
                prompt.push(json!({"type":"image","data":image.get("data"),"mimeType":image.get("mimeType")}));
            }
            let reply = runtime
                .bridge
                .request(
                    "session/prompt",
                    json!({"sessionId":native,"prompt":prompt}),
                    Duration::from_secs(24 * 3600),
                )
                .await;
            let was_cancelled = runtime
                .cancelled
                .swap(false, std::sync::atomic::Ordering::AcqRel);
            self.update(id, Some(&runtime.instance), |v| {
                v.state = "idle".into();
                if was_cancelled {
                    v.error = None;
                }
                if let Ok(ref value) = reply {
                    if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
                        v.context = super::acp::merge_acp_prompt_usage(&v.context, usage);
                        v.capabilities.supports_context_usage = true;
                    }
                }
                for m in &mut v.messages {
                    m.streaming = false;
                }
            });
            match reply {
                Ok(_) => self.turn_finished(id, &runtime),
                Err(_) if was_cancelled => self.turn_finished(id, &runtime),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}
