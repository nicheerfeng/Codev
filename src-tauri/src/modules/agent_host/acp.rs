//! ACP lifecycle and message normalization. No model-provider injection into Pi.
use super::{
    antigravity_history,
    bridge::lock,
    coordinator::{Host, Runtime},
    history,
    protocol::*,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
const TIMEOUT: Duration = Duration::from_secs(120);

/// CLI-owned credentials only. Codev never asks for or stores an agent password.
fn with_auth_hint(harness: &str, error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if !(lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || lower.contains("credential"))
    {
        return error;
    }
    let hint = match harness {
        "acp:codex" => "请在终端运行 codex login（或设置 OPENAI_API_KEY）后重新连接。",
        "acp:antigravity" => "请在 Windows CMD 运行 agy 并按提示完成 Google 登录后重新连接。",
        _ => "请先在对应的命令行程序中完成登录，再重新连接此会话。",
    };
    format!("{error}
{hint}")
}
fn recoverable_missing_session(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no rollout")
        || lower.contains("not found")
        || lower.contains("unknown session")
        || lower.contains("does not exist")
}

fn options(value: &Value) -> Vec<Value> {
    let Some(list) = value.as_array() else {
        return vec![];
    };
    list.iter()
        .flat_map(|item| {
            if let Some(group) = item.get("options").and_then(Value::as_array) {
                group.clone()
            } else {
                vec![item.clone()]
            }
        })
        .collect()
}
fn apply_config(view: &mut SessionView, mut config: Vec<Value>) {
    let has_mode = config
        .iter()
        .any(|o| text(o, "id") == "$mode" || text(o, "category") == "mode");
    if !has_mode {
        if let Some(existing_mode) = view
            .config_options
            .iter()
            .find(|o| text(o, "id") == "$mode" || text(o, "category") == "mode")
            .cloned()
        {
            config.push(existing_mode);
        }
    }
    for option in &config {
        let category = text(option, "category");
        let id = text(option, "id");
        let current = text(option, "currentValue");
        let choices = options(option.get("options").unwrap_or(&Value::Null));
        if category == "model" || id == "model" {
            view.models=choices.iter().map(|v|json!({"id":v.get("value"),"name":v.get("name").or_else(||v.get("label")),"provider":view.binding.harness_id,"configId":id})).collect();
            view.model = view
                .models
                .iter()
                .find(|v| text(v, "id") == current)
                .cloned();
            view.capabilities.supports_model_selection = !view.models.is_empty();
        }
        if matches!(category.as_str(), "thought_level" | "thinking")
            || id.contains("thinking")
            || id == "thought_level"
        {
            view.thinking_levels = choices
                .iter()
                .filter_map(|v| v.get("value").and_then(Value::as_str).map(str::to_string))
                .collect();
            view.thinking_level = current;
            view.capabilities.supports_thinking = view.thinking_levels.len() > 1;
        }
    }
    view.config_options = config;
}
fn apply_session(view: &mut SessionView, response: &Value) {
    if let Some(models) = response.get("models") {
        view.models=models.get("availableModels").and_then(Value::as_array).map(|models|models.iter().map(|m|json!({"id":m.get("modelId"),"name":m.get("name"),"provider":view.binding.harness_id})).collect()).unwrap_or_default();
        view.model = view
            .models
            .iter()
            .find(|m| m.get("id") == models.get("currentModelId"))
            .cloned();
        view.capabilities.supports_model_selection = !view.models.is_empty();
    }
    let mut config = response
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if response.get("modes").is_some() {
        // The dedicated `modes` field is the authoritative permission selector.
        config.retain(|option| text(option, "id") != "mode" && text(option, "category") != "mode");
    }
    if let Some(modes) = response.get("modes") {
        config.push(json!({"id":"$mode","name":"权限模式","category":"mode","type":"select","currentValue":modes.get("currentModeId"),"options":modes.get("availableModes").and_then(Value::as_array).map(|list|list.iter().map(|m|json!({"value":m.get("id"),"name":m.get("name")})).collect::<Vec<_>>()).unwrap_or_default()}));
    }
    if !config.is_empty() {
        apply_config(view, config);
    }
}
impl Host {
    pub async fn initialize_acp(
        self: &Arc<Self>,
        id: &str,
        runtime: &Arc<Runtime>,
    ) -> Result<(), String> {
        let harness = self.view(id)?.binding.harness_id;
        let policy = self.host_tools_policy(&harness);
        let initialize = runtime
            .bridge
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": { "name": "Codev", "version": env!("CARGO_PKG_VERSION") },
                    "clientCapabilities": {
                        "fs": {
                            "readTextFile": policy.read != "deny",
                            "writeTextFile": policy.write != "deny"
                        },
                        "terminal": false
                    }
                }),
                TIMEOUT,
            )
            .await
            .map_err(|error| with_auth_hint(&harness, error))?;
        if initialize.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err("代理返回了不兼容的协议版本".into());
        }
        let capabilities = initialize
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        let resume = capabilities
            .get("loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let view = self.view(id)?;
        let desktop = antigravity_history::is_desktop(&view.binding);
        let mut cwd = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作目录不存在")?;
        if desktop {
            cwd = super::metadata::display_path(&antigravity_history::desktop_cwd(
                view.binding.native_session_id.as_deref().ok_or("缺少 Antigravity 会话标识")?,
            )?);
        }
        self.update(id, Some(&runtime.instance), |v| {
            v.capabilities = Capabilities {
                supports_resume: resume,
                supports_images: capabilities
                    .pointer("/promptCapabilities/image")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                supports_file_mentions: true,
                supports_queue: true,
                ..Capabilities::default()
            }
        });
        let native = lock(&runtime.native_id).clone();
        let mut recovered = false;
        let response = if let Some(native) = native {
            if !resume {
                return Err("该代理不支持恢复原生会话；请新建会话，原有绑定已保留".into());
            }
            if !desktop {
                self.update(id, Some(&runtime.instance), |v| {
                    v.messages.clear();
                    v.history_available = false;
                });
            }
            if desktop {
                runtime.loading_desktop_history.store(true, std::sync::atomic::Ordering::Release);
            }
            let loaded = runtime
                .bridge
                .request(
                    "session/load",
                    json!({"sessionId":native,"cwd":cwd,"mcpServers":[]}),
                    TIMEOUT,
                )
                .await;
            if desktop {
                let drained = runtime.bridge.drain_events().await;
                runtime.loading_desktop_history.store(false, std::sync::atomic::Ordering::Release);
                drained?;
            }
            match loaded {
                Ok(value) => value,
                Err(error) if !desktop && recoverable_missing_session(&error) => {
                    recovered = true;
                    *lock(&runtime.native_id) = None;
                    self.update(id, Some(&runtime.instance), |v| {
                        v.messages.clear();
                    });
                    runtime
                        .bridge
                        .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                        .await
                        .map_err(|error| with_auth_hint(&harness, error))?
                }
                Err(error) => return Err(with_auth_hint(&harness, error)),
            }
        } else {
            runtime
                .bridge
                .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                .await
                .map_err(|error| with_auth_hint(&harness, error))?
        };
        let native = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| lock(&runtime.native_id).clone())
            .ok_or("代理没有返回会话标识")?;
        if desktop && view.binding.native_session_id.as_deref() != Some(native.as_str()) {
            return Err("Antigravity 返回的会话标识与桌面历史不一致".into());
        }
        *lock(&runtime.native_id) = Some(native.clone());
        self.update(id, Some(&runtime.instance), |v| {
            v.binding.native_session_id = Some(native);
            apply_session(v, &response);
            for m in &mut v.messages {
                m.streaming = false;
                if m.status == "streaming" {
                    m.status = "completed".into();
                }
            }
            v.history_loaded = true;
            if recovered {
                v.history_available = false;
                v.messages.push(Message {
                    id: new_id(),
                    kind: "notice".into(),
                    role: "system".into(),
                    text: "原代理会话已无法恢复，Codev 已建立新的原生会话；旧会话的原生记录未被修改。".into(),
                    status: "completed".into(),
                    created_at: now_ms(),
                    ..Message::default()
                });
            }
        });
        Ok(())
    }
    pub fn handle_acp_frame(self: &Arc<Self>, id: &str, runtime: &Arc<Runtime>, frame: Value) {
        let method = text(&frame, "method");
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        match method.as_str() {
            "session/update" => {
                let update = params.get("update").unwrap_or(&Value::Null);
                let kind = text(update, "sessionUpdate");
                if runtime.loading_desktop_history.load(std::sync::atomic::Ordering::Acquire)
                    && matches!(kind.as_str(), "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" | "tool_call" | "tool_call_update" | "plan")
                {
                    return;
                }
                self.update(id, Some(&runtime.instance), |v| match kind.as_str() {
                    "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
                        let role = if kind == "user_message_chunk" {
                            "user"
                        } else {
                            "assistant"
                        };
                        let thought = kind == "agent_thought_chunk";
                        let content = update.get("content").unwrap_or(&Value::Null);
                        let chunk = history::content_text(content);
                        let same = v
                            .messages
                            .last()
                            .filter(|m| m.kind == "message" && m.role == role && m.streaming)
                            .map(|m| m.id.clone());
                        if same.is_none() {
                            v.messages.push(Message {
                                id: new_id(),
                                kind: "message".into(),
                                role: role.into(),
                                streaming: true,
                                status: "streaming".into(),
                                created_at: now_ms(),
                                raw_kind: kind.clone(),
                                ..Message::default()
                            });
                        }
                        if let Some(message) = v.messages.last_mut() {
                            if thought {
                                message.thinking.push_str(&chunk);
                            } else {
                                message.text.push_str(&chunk);
                            }
                            if text(content, "type") == "image" {
                                message.images.push(content.clone());
                            }
                        }
                    }
                    "tool_call" | "tool_call_update" => {
                        for message in &mut v.messages {
                            message.streaming = false;
                        }
                        let call = text(update, "toolCallId");
                        let existing = v
                            .messages
                            .iter()
                            .rposition(|m| m.tool_call_id == call && m.kind == "toolCall");
                        let index = if let Some(i) = existing {
                            i
                        } else {
                            v.messages.push(Message {
                                id: format!("acp-tool:{}:{call}", runtime.instance),
                                kind: "toolCall".into(),
                                role: "tool".into(),
                                tool_call_id: call,
                                created_at: now_ms(),
                                raw_kind: kind.clone(),
                                ..Message::default()
                            });
                            v.messages.len() - 1
                        };
                        let tool = &mut v.messages[index];
                        if let Some(title) = update.get("title").and_then(Value::as_str) {
                            tool.tool_name = title.into();
                        }
                        if let Some(tk) = update.get("kind").and_then(Value::as_str) {
                            tool.tool_kind = tk.into();
                        }
                        if let Some(locs) = update.get("locations").and_then(Value::as_array) {
                            if !locs.is_empty() {
                                tool.locations = locs.clone();
                            }
                        }
                        if let Some(status) = update.get("status").and_then(Value::as_str) {
                            tool.status = status.into();
                            tool.is_error = matches!(status, "failed" | "error");
                        }
                        if let Some(args) = update.get("rawInput") {
                            let is_empty_obj = args
                                .as_object()
                                .is_some_and(serde_json::Map::is_empty);
                            let has_existing = tool
                                .arguments
                                .as_object()
                                .is_some_and(|o| !o.is_empty());
                            if !args.is_null() && !(is_empty_obj && has_existing) {
                                tool.arguments = args.clone();
                            }
                        }
                        if let Some(output) = update.get("rawOutput") {
                            tool.text = if output.is_string() {
                                output.as_str().unwrap_or_default().into()
                            } else {
                                serde_json::to_string_pretty(output).unwrap_or_default()
                            };
                        }
                        if let Some(content) = update.get("content").and_then(Value::as_array) {
                            let mut diffs = vec![];
                            let mut blocks = vec![];
                            for c in content {
                                if let Some(diff) = c.get("diff") {
                                    diffs.push(diff.clone());
                                    let old_t = text(diff, "oldText");
                                    let new_t = text(diff, "newText");
                                    if !old_t.is_empty() || !new_t.is_empty() {
                                        blocks.push(format!("--- old\n{old_t}\n+++ new\n{new_t}"));
                                    }
                                } else {
                                    let txt = history::content_text(c.get("content").unwrap_or(c));
                                    if !txt.is_empty() {
                                        blocks.push(txt);
                                    }
                                }
                            }
                            if let Some(first) = diffs.first() {
                                tool.diff = if diffs.len() == 1 {
                                    Some(first.clone())
                                } else {
                                    Some(json!({ "items": diffs }))
                                };
                            }
                            if !blocks.is_empty() {
                                tool.text = blocks.join("\n");
                            }
                        }
                    }
                    "config_option_update" => {
                        if let Some(config) = update.get("configOptions").and_then(Value::as_array)
                        {
                            apply_config(v, config.clone());
                        }
                    }
                    "current_mode_update" => {
                        if let Some(mode) = v
                            .config_options
                            .iter_mut()
                            .find(|c| text(c, "id") == "$mode")
                        {
                            mode["currentValue"] =
                                update.get("currentModeId").cloned().unwrap_or(Value::Null);
                        }
                    }
                    "session_info_update" => {
                        if let Some(title) = update.get("title").and_then(Value::as_str) {
                            v.binding.title = title.chars().take(160).collect();
                        }
                    }
                    "available_commands_update" => {
                        v.commands = update
                            .get("availableCommands")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        v.capabilities.supports_skills = !v.commands.is_empty();
                    }
                    "plan" => {
                        v.messages.push(Message {
                            id: new_id(),
                            kind: "plan".into(),
                            role: "system".into(),
                            text: serde_json::to_string_pretty(
                                update.get("entries").unwrap_or(&Value::Null),
                            )
                            .unwrap_or_default(),
                            raw_kind: kind.clone(),
                            ..Message::default()
                        });
                    }
                    "usage_update" => {
                        v.context = update.clone();
                        v.capabilities.supports_context_usage = true;
                    }
                    _ => {}
                });
            }
            "session/request_permission" => {
                let Some(native_id) = frame.get("id").cloned() else {
                    return;
                };
                let key = new_id();
                lock(&runtime.permission_ids).insert(key.clone(), native_id);
                let tool = params.get("toolCall").unwrap_or(&Value::Null);
                self.update(id, Some(&runtime.instance), |v| {
                    v.capabilities.supports_permission = true;
                    v.pending_requests.push(PendingRequest {
                        id: key,
                        kind: "permission".into(),
                        title: text(tool, "title"),
                        message: serde_json::to_string_pretty(
                            tool.get("rawInput").unwrap_or(&Value::Null),
                        )
                        .unwrap_or_default(),
                        options: params
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                        default_value: String::new(),
                    });
                });
            }
            "fs/read_text_file" | "fs/write_text_file" => {
                let Some(request_id) = frame.get("id").cloned() else {
                    return;
                };
                let host = self.clone();
                let sid = id.to_string();
                let run = runtime.clone();
                tokio::spawn(async move {
                    let reply = host
                        .agent_file(&sid, &params, method == "fs/write_text_file")
                        .await;
                    let result = match reply {
                        Ok(value) => json!({"jsonrpc":"2.0","id":request_id,"result":value}),
                        Err(e) => {
                            json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32000,"message":e}})
                        }
                    };
                    let _ = run.bridge.send(result);
                });
            }
            _ => {
                if let Some(request_id) = frame.get("id") {
                    let _=runtime.bridge.send(json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Codev 未声明支持此客户端方法"}}));
                }
            }
        }
    }
    pub async fn set_acp_config(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        config_id: &str,
        value: &str,
    ) -> Result<Value, String> {
        let native = lock(&runtime.native_id).clone().ok_or("会话尚未初始化")?;
        let response = if config_id == "$mode" {
            runtime
                .bridge
                .request(
                    "session/set_mode",
                    json!({"sessionId":native,"modeId":value}),
                    TIMEOUT,
                )
                .await?
        } else {
            runtime
                .bridge
                .request(
                    "session/set_config_option",
                    json!({"sessionId":native,"configId":config_id,"value":value}),
                    TIMEOUT,
                )
                .await?
        };
        self.update(id, Some(&runtime.instance), |v| {
            if let Some(config) = response.get("configOptions").and_then(Value::as_array) {
                apply_config(v, config.clone());
            } else if let Some(option) = v
                .config_options
                .iter_mut()
                .find(|c| text(c, "id") == config_id)
            {
                option["currentValue"] = json!(value);
                let config = v.config_options.clone();
                apply_config(v, config);
            }
        });
        Ok(response)
    }
    pub(super) async fn agent_file(
        &self,
        id: &str,
        params: &Value,
        write: bool,
    ) -> Result<Value, String> {
        let view = self.view(id)?;
        let policy = self.host_tools_policy(&view.binding.harness_id);
        if write && policy.write == "deny" {
            return Err("当前策略禁止代理写入工作区文件".into());
        }
        if !write && policy.read == "deny" {
            return Err("当前策略禁止代理读取工作区文件".into());
        }
        let root = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作区不存在")?;
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let requested = std::path::PathBuf::from(text(params, "path"));
        let requested = if requested.is_absolute() {
            requested
        } else {
            root.join(requested)
        };
        let canonical = if requested.exists() {
            std::fs::canonicalize(&requested)
        } else {
            requested
                .parent()
                .ok_or("文件路径无效")
                .and_then(|p| std::fs::canonicalize(p).map_err(|_| "父目录不存在"))
                .map(|p| p.join(requested.file_name().unwrap_or_default()))
                .map_err(std::io::Error::other)
        }
        .map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root) {
            return Err("代理文件请求超出绑定工作区".into());
        }
        if write {
            let content = text(params, "content");
            if content.len() > 8 * 1024 * 1024 {
                return Err("文件内容超过限制".into());
            }
            let runtime = lock(&self.runtimes).get(id).cloned();
            let auto_allow = policy.write == "allow"
                || runtime
                    .as_ref()
                    .is_some_and(|r| r.session_auto_write.load(std::sync::atomic::Ordering::Acquire));
            if !auto_allow {
                let Some(runtime) = runtime else {
                    return Err("写入需要运行时确认".into());
                };
                let rel = canonical
                    .strip_prefix(&root)
                    .map(super::metadata::display_path)
                    .unwrap_or_else(|_| super::metadata::display_path(&canonical));
                let existing = tokio::fs::read_to_string(&canonical).await.unwrap_or_default();
                let preview = if existing.is_empty() {
                    format!(
                        "新建文件 {rel}（{} 字节）\n{}",
                        content.len(),
                        content.lines().take(20).collect::<Vec<_>>().join("\n")
                    )
                } else {
                    format!(
                        "覆盖写入 {rel}（原 {} 字节 -> 新 {} 字节）\n{}",
                        existing.len(),
                        content.len(),
                        content.lines().take(20).collect::<Vec<_>>().join("\n")
                    )
                };
                let request_id = format!("fs-write:{}", new_id());
                let (tx, rx) = tokio::sync::oneshot::channel();
                lock(&runtime.fs_approvals).insert(request_id.clone(), tx);
                self.update(id, Some(&runtime.instance), |v| {
                    v.capabilities.supports_permission = true;
                    v.pending_requests.push(PendingRequest {
                        id: request_id.clone(),
                        kind: "permission".into(),
                        title: format!("写入工作区文件：{rel}"),
                        message: preview,
                        options: vec![
                            json!({"optionId":"allow_once","name":"允许本次写入","kind":"allow_once"}),
                            json!({"optionId":"allow_session","name":"本会话允许自动写入","kind":"allow_always"}),
                            json!({"optionId":"reject","name":"拒绝写入","kind":"reject_once"}),
                        ],
                        default_value: "reject".into(),
                    });
                });
                let approved = rx.await.unwrap_or(false);
                self.update(id, Some(&runtime.instance), |v| {
                    v.pending_requests.retain(|p| p.id != request_id);
                });
                if !approved {
                    return Err("用户拒绝写入文件".into());
                }
            }
            tokio::fs::write(canonical, content)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        } else {
            let meta = tokio::fs::metadata(&canonical)
                .await
                .map_err(|e| e.to_string())?;
            if meta.len() > 8 * 1024 * 1024 {
                return Err("文件超过读取限制".into());
            }
            let content = tokio::fs::read_to_string(canonical)
                .await
                .map_err(|e| e.to_string())?;
            let start = params
                .get("line")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .saturating_sub(1) as usize;
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX)
                .min(usize::MAX as u64) as usize;
            Ok(
                json!({"content":content.lines().skip(start).take(limit).collect::<Vec<_>>().join("\n")}),
            )
        }
    }
}
