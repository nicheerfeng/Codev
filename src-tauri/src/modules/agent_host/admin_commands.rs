//! Workspace, harness configuration, usage, models, assets and remote device command handlers.
//! Extracted from `commands.rs` to establish clean per-domain command boundaries.

use super::{
    adapter::{HarnessAdapter, QUERY_TIMEOUT},
    bridge::{lock, Wire},
    coordinator::Host,
    protocol::*,
    registry,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

impl Host {
    pub(super) async fn execute_workspace_command(
        self: &Arc<Self>,
        principal: &Principal,
        command: &Command,
    ) -> Result<Value, String> {
        let payload = &command.payload;
        match command.operation.as_str() {
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
                drop(st);
                self.sync_vcs_watchers();
                Ok(json!({}))
            }
            "workspace.skills" => {
                let wid = text(payload, "workspaceId");
                let adapter = HarnessAdapter::for_harness_id(&text(payload, "harnessId"));
                if !adapter.supports_workspace_skill_scan() {
                    return Err("该代理的技能由运行时提供".into());
                }
                let mut cwd = lock(&self.state)
                    .workspaces
                    .get(&wid)
                    .map(|w| w.cwd.clone())
                    .ok_or("工作区不存在")?;
                let session = self.view(command.session_id.as_deref().ok_or("缺少会话标识")?)?;
                if session.binding.workspace_id != wid
                    || HarnessAdapter::for_harness_id(&session.binding.harness_id) != adapter
                {
                    return Err("技能目录与当前会话不匹配".into());
                }
                if super::antigravity_history::is_desktop(&session.binding) {
                    let native = session
                        .binding
                        .native_session_id
                        .as_deref()
                        .ok_or("缺少 Antigravity 会话标识")?;
                    cwd = super::metadata::display_path(&super::antigravity_history::desktop_cwd(
                        native,
                    )?);
                }
                let skills = tokio::task::spawn_blocking(move || {
                    let home = dirs::home_dir().unwrap_or_default();
                    let gemini = match std::env::var_os("GEMINI_HOME") {
                        Some(value) if !value.is_empty() => {
                            let path = std::path::PathBuf::from(value);
                            if let Ok(rest) = path.strip_prefix("~") {
                                home.join(rest)
                            } else {
                                path
                            }
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
                            if directory.starts_with('.') {
                                continue;
                            }
                            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                                continue;
                            };
                            let Some(frontmatter) = content
                                .strip_prefix("---\n")
                                .or_else(|| content.strip_prefix("---\r\n"))
                                .and_then(|body| body.split_once("\n---").map(|(header, _)| header))
                            else {
                                continue;
                            };
                            let Ok(metadata) = serde_yaml::from_str::<serde_yaml::Value>(frontmatter)
                            else {
                                continue;
                            };
                            let Some(name) = metadata
                                .get("name")
                                .and_then(serde_yaml::Value::as_str)
                                .map(str::trim)
                                .filter(|name| !name.is_empty() && !name.chars().any(char::is_whitespace))
                            else {
                                continue;
                            };
                            let description = metadata
                                .get("description")
                                .and_then(serde_yaml::Value::as_str)
                                .unwrap_or("");
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
            op => Err(format!("不支持的工作区操作：{op}")),
        }
    }

    pub(super) async fn execute_harness_and_settings_command(
        self: &Arc<Self>,
        principal: &Principal,
        command: &Command,
    ) -> Result<Value, String> {
        let operation = command.operation.as_str();
        let payload = &command.payload;
        match operation {
            "harness.list" => Ok(json!(self.harnesses())),
            "usage.sync" => {
                principal.require_desktop()?;
                let _guard = self.usage_sync.lock().await;
                let directory = self.directory.clone();
                tokio::task::spawn_blocking(move || super::usage::sync(&directory))
                    .await
                    .map_err(|e| e.to_string())?
            }
            "usage.query" => {
                principal.require_desktop()?;
                let directory = self.directory.clone();
                let options = payload.clone();
                tokio::task::spawn_blocking(move || super::usage::query(&directory, &options))
                    .await
                    .map_err(|e| e.to_string())?
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
                let descriptor = self
                    .harnesses()
                    .into_iter()
                    .find(|h| h.id == "pi")
                    .ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.push("--version".into());
                let version = tokio::task::spawn_blocking(move || {
                    super::pi_settings::run_command(&binary, &args, Duration::from_secs(10))
                })
                .await
                .map_err(|e| e.to_string())??;
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
                let descriptor = self
                    .harnesses()
                    .into_iter()
                    .find(|h| h.id == "pi")
                    .ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.extend([
                    "--mode".into(),
                    "rpc".into(),
                    "--no-session".into(),
                    "--no-tools".into(),
                    "--no-extensions".into(),
                    "--no-skills".into(),
                    "--no-prompt-templates".into(),
                    "--no-context-files".into(),
                ]);
                let cwd = super::history::pi_home()
                    .filter(|p| p.is_dir())
                    .or_else(dirs::home_dir)
                    .ok_or("无法定位工作目录")?;
                let (bridge, mut frames) = tokio::task::spawn_blocking(move || {
                    super::bridge::Bridge::spawn(&binary, &args, &cwd, Wire::Pi)
                })
                .await
                .map_err(|e| e.to_string())??;
                let started = std::time::Instant::now();
                let result = tokio::time::timeout(Duration::from_secs(60), async {
                    bridge
                        .request(
                            "set_model",
                            json!({"provider": provider, "modelId": model}),
                            QUERY_TIMEOUT,
                        )
                        .await?;
                    bridge
                        .request("prompt", json!({"message": "Reply only OK."}), QUERY_TIMEOUT)
                        .await?;
                    let mut received_text = false;
                    while let Some(frame) = frames.recv().await {
                        if frame.get("type").and_then(Value::as_str) == Some("message_end") {
                            if let Some(message) = frame.get("message") {
                                if let Some(error) = message
                                    .get("errorMessage")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.trim().is_empty())
                                {
                                    return Err(error.to_string());
                                }
                                if message.get("role").and_then(Value::as_str) == Some("assistant") {
                                    received_text |= !super::history::content_text(
                                        message.get("content").unwrap_or(&Value::Null),
                                    )
                                    .trim()
                                    .is_empty();
                                }
                            }
                        }
                        if frame.get("type").and_then(Value::as_str) == Some("agent_end") {
                            return if received_text {
                                Ok(())
                            } else {
                                Err("模型没有返回文本".into())
                            };
                        }
                    }
                    Err("Pi 测试进程已退出".into())
                })
                .await;
                bridge.close();
                result.map_err(|_| "模型测试超时".to_string())??;
                Ok(json!({ "elapsedMs": started.elapsed().as_millis() as u64 }))
            }
            "pi.assets.list" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                let cwd = lock(&self.state)
                    .workspaces
                    .get(&workspace_id)
                    .map(|w| w.cwd.clone());
                super::pi_settings::assets(&text(payload, "kind"), cwd.as_deref())
            }
            "harness.assets.list" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                let cwd = lock(&self.state)
                    .workspaces
                    .get(&workspace_id)
                    .map(|w| w.cwd.clone());
                let harness = text(payload, "harnessId");
                let kind = text(payload, "kind");
                tokio::task::spawn_blocking(move || match kind.as_str() {
                    "skills" => super::asset_inventory::skills(&harness, cwd.as_deref()),
                    "plugins" => super::asset_inventory::plugins(&harness),
                    _ => Err("不支持的资源类型".into()),
                })
                .await
                .map_err(|e| e.to_string())?
            }
            "harness.providers.list" => {
                principal.require_desktop()?;
                super::providers::list(self, &text(payload, "harnessId"))
            }
            "harness.providers.save" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.write().await;
                super::providers::save(self, &text(payload, "harnessId"), payload)
            }
            "harness.providers.native.save" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.write().await;
                super::providers::save_codex_native(self, payload)
            }
            "harness.providers.import"
            | "harness.providers.duplicate"
            | "harness.providers.discover" => {
                principal.require_desktop()?;
                let harness = text(payload, "harnessId");
                let id = text(payload, "id");
                let host = self.clone();
                let op = operation.to_owned();
                let _gate = if operation == "harness.providers.discover" {
                    None
                } else {
                    Some(self.provider_gate.write().await)
                };
                tokio::task::spawn_blocking(move || {
                    super::providers::catalog_action(&host, &harness, &id, &op)
                })
                .await
                .map_err(|e| e.to_string())?
            }
            "harness.providers.remove" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.write().await;
                super::providers::remove(self, &text(payload, "harnessId"), &text(payload, "id"))
            }
            "harness.providers.activate" => {
                principal.require_desktop()?;
                let _gate = self.provider_gate.write().await;
                super::providers::activate(self, &text(payload, "harnessId"), &text(payload, "id"))
                    .await
            }
            "harness.providers.reconnect" => {
                principal.require_desktop()?;
                let harness = text(payload, "harnessId");
                let id = text(payload, "id");
                let ids = {
                    let _providers = self.provider_gate.write().await;
                    super::providers::prepare_reconnect(self, &harness, &id).await?
                };
                let mut failures = Vec::new();
                for id in &ids {
                    if let Err(error) = self.ensure_runtime(id).await {
                        failures.push(format!(
                            "{}：{}",
                            self.view(id)
                                .map(|v| v.binding.title)
                                .unwrap_or_else(|_| id.clone()),
                            error
                        ));
                    }
                }
                if !failures.is_empty() {
                    return Err(format!(
                        "配置已保存，但部分线程重新连接失败：{}",
                        failures.join("；")
                    ));
                }
                Ok(json!({"count": ids.len()}))
            }
            "pi.plugins.install" => {
                principal.require_desktop()?;
                let package = text(payload, "package");
                let allowed = [
                    "pi-mcp-adapter",
                    "pi-lens",
                    "pi-subagents",
                    "@ogulcancelik/pi-codex-subagents",
                    "pi-intercom",
                    "pi-feishu-lark",
                    "pi-hide-providers",
                    "pi-rename-session",
                ];
                if !allowed.contains(&package.as_str()) {
                    return Err("不支持的推荐插件".into());
                }
                let descriptor = self
                    .harnesses()
                    .into_iter()
                    .find(|h| h.id == "pi")
                    .ok_or("Pi 未配置")?;
                let (binary, mut args) = registry::launch(&descriptor)?;
                args.extend(["install".into(), format!("npm:{package}")]);
                let message = tokio::task::spawn_blocking(move || {
                    super::pi_settings::run_command(&binary, &args, Duration::from_secs(180))
                })
                .await
                .map_err(|e| e.to_string())??;
                Ok(json!({ "message": message }))
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
            "harness.docs.read" => {
                principal.require_desktop()?;
                let pi_home = super::history::pi_home();
                let pi_append_path = pi_home.as_ref().map(|p| p.join("APPEND_SYSTEM.md"));
                let pi_models_path = pi_home.as_ref().map(|p| p.join("models.json"));
                let codex_agents_path = dirs::home_dir().map(|h| h.join(".codex/AGENTS.md"));
                let antigravity_agents_path = dirs::home_dir().map(|h| h.join(".gemini/AGENTS.md"));
                let read_opt = |p: Option<&std::path::PathBuf>| -> Result<String, String> {
                    let Some(path) = p else {
                        return Ok(String::new());
                    };
                    match std::fs::read_to_string(path) {
                        Ok(content) => Ok(content),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            Ok(String::new())
                        }
                        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
                    }
                };
                let pi_models_providers = pi_models_path
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| {
                        v.get("providers")
                            .and_then(|p| p.as_object())
                            .map(|o| o.keys().cloned().collect::<Vec<_>>())
                    })
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
                    if current != expected {
                        return Err("配置文件已被其他程序修改，请重新打开设置后再保存".into());
                    }
                }
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    let mut file =
                        tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                    std::io::Write::write_all(&mut file, content.as_bytes())
                        .map_err(|e| e.to_string())?;
                    file.persist(&path).map_err(|e| e.error.to_string())?;
                } else {
                    return Err("无法定位配置目录".into());
                }
                Ok(json!({ "saved": super::metadata::display_path(&path) }))
            }
            op => Err(format!("不支持的代理配置操作：{op}")),
        }
    }

    pub(super) async fn execute_host_admin_command(
        self: &Arc<Self>,
        principal: &Principal,
        command: &Command,
    ) -> Result<Value, String> {
        let operation = command.operation.as_str();
        let payload = &command.payload;
        match operation {
            "host.project_harnesses.get" => {
                principal.require_desktop()?;
                Ok(lock(&self.store)
                    .preference("projectHarnesses")
                    .unwrap_or(Value::Null))
            }
            "host.project_harnesses.set" => {
                principal.require_desktop()?;
                let workspace_id = text(payload, "workspaceId");
                if !lock(&self.state).workspaces.contains_key(&workspace_id) {
                    return Err("工作区不存在".into());
                }
                let ids = payload
                    .get("harnessIds")
                    .and_then(Value::as_array)
                    .ok_or("缺少代理列表")?;
                let available = self.harnesses();
                if ids.iter().any(|id| {
                    !id.as_str()
                        .is_some_and(|id| available.iter().any(|h| h.id == id))
                }) {
                    return Err("代理列表包含未注册的代理".into());
                }
                let store = lock(&self.store);
                let mut all = store
                    .preference("projectHarnesses")
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                all.insert(workspace_id, json!(ids));
                store.set_preference("projectHarnesses", &Value::Object(all))?;
                Ok(json!({}))
            }
            "host.policy.get" => {
                let policies = lock(&self.store)
                    .preference("hostToolsPolicy")
                    .unwrap_or_else(|| json!({}));
                let trusted = lock(&self.store)
                    .preference("trustedPiExtensions")
                    .unwrap_or_else(|| json!({}));
                let git_ui_enabled = self.vcs_background_enabled();
                Ok(json!({
                    "policies": policies,
                    "trustedPiExtensions": trusted,
                    "gitUiEnabled": git_ui_enabled,
                }))
            }
            "host.policy.set" => {
                principal.require_desktop()?;
                if let Some(harness_id) = payload.get("harnessId").and_then(Value::as_str) {
                    let read = payload
                        .get("read")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    let write = text(payload, "write");
                    let write_val = match write.as_str() {
                        "deny" | "ask" | "allow" => write,
                        _ => "ask".into(),
                    };
                    let store = lock(&self.store);
                    let mut all = store
                        .preference("hostToolsPolicy")
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    all.insert(
                        harness_id.into(),
                        json!({ "read": read, "write": write_val }),
                    );
                    store.set_preference("hostToolsPolicy", &Value::Object(all))?;
                }
                if let Some(cwd) = payload.get("trustWorkspaceCwd").and_then(Value::as_str) {
                    let store = lock(&self.store);
                    let mut all = store
                        .preference("trustedPiExtensions")
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    if let Some(trusted) = payload.get("trusted").and_then(Value::as_bool) {
                        all.insert(cwd.into(), json!(trusted));
                    } else {
                        all.remove(cwd);
                    }
                    store.set_preference("trustedPiExtensions", &Value::Object(all))?;
                }
                if let Some(enabled) = payload.get("gitUiEnabled").and_then(Value::as_bool) {
                    self.set_vcs_background_enabled(enabled)?;
                }
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
                let remote_write_devices = lock(&self.store)
                    .preference("remoteWriteDevices")
                    .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                    .unwrap_or_default();
                Ok(json!({
                    "devices": devices,
                    "pending": pending,
                    "remoteWriteDevices": remote_write_devices,
                }))
            }
            "host.device.write" => {
                principal.require_desktop()?;
                let list = self.set_device_write(
                    &text(payload, "id"),
                    payload
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?;
                Ok(json!({ "remoteWriteDevices": list }))
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
            op => Err(format!("不支持的主机管理操作：{op}")),
        }
    }
}
