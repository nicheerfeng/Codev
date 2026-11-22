use super::{
    bridge::{lock, Wire},
    coordinator::{Host, Runtime},
    history,
    protocol::*,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
const QUERY_TIMEOUT: Duration = Duration::from_secs(120);

fn build_context_value(usage: &Value, model: &Option<Value>) -> Value {
    let summed = ["input", "output", "cacheRead", "cacheWrite"]
        .iter()
        .filter_map(|k| usage.get(k).and_then(Value::as_u64))
        .sum::<u64>();
    let total = usage
        .get("totalTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .max(summed);
    let window = model
        .as_ref()
        .and_then(|m| m.get("contextWindow"))
        .and_then(Value::as_u64);
    json!({
        "tokens": total,
        "window": window,
        "percent": window.filter(|w| *w > 0).map(|w| total as f64 / w as f64 * 100.0),
        "usage": usage,
    })
}

fn public_model(model: &Value) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "id",
        "provider",
        "name",
        "contextWindow",
        "maxTokens",
        "reasoning",
        "input",
        "thinkingLevelMap",
    ] {
        if let Some(value) = model.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    Value::Object(output)
}

impl Host {
    pub async fn initialize_pi(
        self: &Arc<Self>,
        id: &str,
        runtime: &Arc<Runtime>,
    ) -> Result<(), String> {
        self.refresh_pi(id, runtime, true).await
    }
    pub async fn refresh_pi(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        initial: bool,
    ) -> Result<(), String> {
        let state = runtime
            .bridge
            .request("get_state", json!({}), QUERY_TIMEOUT)
            .await?;
        let models = runtime
            .bridge
            .request("get_available_models", json!({}), QUERY_TIMEOUT)
            .await?;
        let levels = runtime
            .bridge
            .request("get_available_thinking_levels", json!({}), QUERY_TIMEOUT)
            .await
            .ok();
        let commands = if initial {
            runtime
                .bridge
                .request("get_commands", json!({}), QUERY_TIMEOUT)
                .await
                .ok()
        } else {
            None
        };
        // Read native history in bounded pages; get_entries can return an unbounded lifetime transcript.
        let session_path = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(std::path::PathBuf::from);
        let native_history = if initial {
            if let Some(path) = session_path.clone() {
                tokio::task::spawn_blocking(move || {
                    let history = history::read_pi(&path, None).ok();
                    let (_, usage) = history::pi_tail_summary(&path);
                    (history, usage)
                })
                .await
                .ok()
            } else {
                None
            }
        } else {
            None
        };
        let (native_messages, tail_usage) = match native_history {
            Some((msgs, usage)) => (msgs, usage),
            None => (None, None),
        };
        let messages = if initial && native_messages.is_none() {
            runtime
                .bridge
                .request("get_messages", json!({}), QUERY_TIMEOUT)
                .await
                .ok()
        } else {
            None
        };
        self.update(id, Some(&runtime.instance), |v| {
            v.models = models
                .get("models")
                .and_then(Value::as_array)
                .map(|models| models.iter().map(public_model).collect())
                .unwrap_or_default();
            v.model = state
                .get("model")
                .filter(|m| m.is_object())
                .map(public_model);
            v.thinking_level = text(&state, "thinkingLevel");
            if state.get("isCompacting") == Some(&json!(true)) {
                v.state = "compacting".into();
            } else if state.get("isStreaming") == Some(&json!(true)) {
                v.state = "working".into();
            }
            v.thinking_levels = levels
                .as_ref()
                .and_then(|l| l.get("levels"))
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|l| l.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(path) = state.get("sessionFile").and_then(Value::as_str) {
                v.binding.native_session_path =
                    Some(super::metadata::display_path(std::path::Path::new(path)));
            }
            if let Some(sid) = state.get("sessionId").and_then(Value::as_str) {
                v.binding.native_session_id = Some(sid.into());
            }
            if let Some(title) = state
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                v.binding.title = title.into();
            }
            v.capabilities = Capabilities {
                supports_resume: true,
                supports_fork: true,
                supports_thinking: v.thinking_levels.len() > 1,
                supports_permission: false,
                supports_images: v
                    .model
                    .as_ref()
                    .and_then(|m| m.get("input"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().any(|i| i == "image"))
                    .unwrap_or(false),
                supports_file_mentions: true,
                supports_queue: true,
                supports_compaction: true,
                supports_model_selection: !v.models.is_empty(),
                supports_skills: commands
                    .as_ref()
                    .and_then(|c| c.get("commands"))
                    .and_then(Value::as_array)
                    .map(|c| !c.is_empty())
                    .unwrap_or(!v.commands.is_empty()),
                supports_extension_ui: true,
                supports_context_usage: v
                    .model
                    .as_ref()
                    .and_then(|m| m.get("contextWindow"))
                    .and_then(Value::as_u64)
                    .map(|w| w > 0)
                    .unwrap_or(false),
            };
            if let Some(commands) = commands {
                v.commands = commands
                    .get("commands")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
            }
            if v.context.is_null() {
                if let Some(usage) = tail_usage {
                    v.context = build_context_value(&usage, &v.model);
                }
            }
            if initial {
                if let Some((messages, offset)) = native_messages {
                    if v.history_loaded && v.history_offset < offset && !v.messages.is_empty() {
                        let tail_ids: std::collections::HashSet<String> =
                            messages.iter().map(|m| m.id.clone()).collect();
                        v.messages.retain(|m| !tail_ids.contains(&m.id));
                        v.messages.extend(messages);
                    } else {
                        v.messages = messages;
                        v.history_offset = offset;
                    }
                } else if let Some(messages) = messages {
                    let list = messages
                        .get("messages")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let mut normalized = vec![];
                    for (i, m) in list.iter().enumerate() {
                        for part in history::message_parts(m, &format!("restored:{i}")) {
                            history::push_with_tool_merge(&mut normalized, part);
                        }
                    }
                    v.messages = normalized;
                }
                v.history_loaded = true;
                v.history_available = true;
            }
        });
        if let Some(native) = self.view(id)?.binding.native_session_id {
            *lock(&runtime.native_id) = Some(native);
        }
        self.persist(id)?;
        Ok(())
    }
    pub fn handle_frame(self: &Arc<Self>, id: &str, runtime: &Arc<Runtime>, frame: Value) {
        if self.view(id).ok().and_then(|v| v.instance_id).as_deref()
            != Some(runtime.instance.as_str())
        {
            return;
        }
        if runtime.bridge.wire == Wire::Acp {
            self.handle_acp_frame(id, runtime, frame);
            return;
        }
        let kind = text(&frame, "type");
        let mut finished = false;
        self.update(id, Some(&runtime.instance), |v| match kind.as_str() {
            "agent_start" => {
                v.state = "working".into();
                v.error = None;
            }
            "message_start" => {
                let m = frame.get("message").unwrap_or(&Value::Null);
                let role = text(m, "role");
                if role == "assistant" {
                    let message_id = new_id();
                    let parts = history::message_parts(m, &message_id);
                    if let Some(mut msg) = parts.into_iter().find(|p| p.kind == "message") {
                        msg.streaming = true;
                        msg.status = "streaming".into();
                        if msg.created_at == 0 {
                            msg.created_at = now_ms();
                        }
                        msg.raw_kind = kind.clone();
                        msg.source_event_id = None;
                        v.messages.push(msg);
                    } else {
                        v.messages.push(Message {
                            id: message_id,
                            kind: "message".into(),
                            role: "assistant".into(),
                            streaming: true,
                            status: "streaming".into(),
                            created_at: now_ms(),
                            raw_kind: kind.clone(),
                            ..Message::default()
                        });
                    }
                }
            }
            "message_update" => {
                if let Some(delta) = frame.get("assistantMessageEvent") {
                    let delta_type = text(delta, "type");
                    let idx = v
                        .messages
                        .iter()
                        .rposition(|m| m.role == "assistant" && m.kind == "message" && m.streaming);
                    let idx = match idx {
                        Some(i) => i,
                        None => {
                            v.messages.push(Message {
                                id: new_id(),
                                kind: "message".into(),
                                role: "assistant".into(),
                                streaming: true,
                                status: "streaming".into(),
                                created_at: now_ms(),
                                raw_kind: kind.clone(),
                                ..Message::default()
                            });
                            v.messages.len() - 1
                        }
                    };
                    let msg = &mut v.messages[idx];
                    match delta_type.as_str() {
                        "text_delta" => {
                            if let Some(piece) = delta.get("delta").and_then(Value::as_str) {
                                msg.text.push_str(piece);
                            }
                        }
                        "thinking_delta" => {
                            if let Some(piece) = delta.get("delta").and_then(Value::as_str) {
                                msg.thinking.push_str(piece);
                            }
                        }
                        "text_end" => {
                            if msg.text.is_empty() {
                                if let Some(full) = delta.get("content").and_then(Value::as_str) {
                                    msg.text = full.into();
                                }
                            }
                        }
                        "thinking_end" => {
                            if msg.thinking.is_empty() {
                                if let Some(full) = delta.get("content").and_then(Value::as_str) {
                                    msg.thinking = full.into();
                                }
                            }
                        }
                        _ => {}
                    }
                    if let Some(usage) = frame.get("usage").or_else(|| delta.get("usage")) {
                        v.context = build_context_value(usage, &v.model);
                    }
                } else {
                    let m = frame.get("message").unwrap_or(&Value::Null);
                    if text(m, "role") == "assistant" {
                        let current = v
                            .messages
                            .iter()
                            .rev()
                            .find(|m| m.role == "assistant" && m.kind == "message" && m.streaming)
                            .map(|m| m.id.clone());
                        let message_id = current.unwrap_or_else(new_id);
                        for mut part in history::message_parts(m, &message_id) {
                            if part.kind != "message" {
                                continue;
                            }
                            part.streaming = true;
                            part.status = "streaming".into();
                            part.created_at = now_ms();
                            part.raw_kind = kind.clone();
                            part.source_event_id = None;
                            if let Some(old) = v.messages.iter_mut().find(|m| m.id == part.id) {
                                *old = part;
                            } else {
                                v.messages.push(part);
                            }
                        }
                    }
                }
            }
            "message_end" => {
                let m = frame.get("message").unwrap_or(&Value::Null);
                let role = text(m, "role");
                if role == "assistant" {
                    let streaming_idx = v
                        .messages
                        .iter()
                        .rposition(|m| m.role == "assistant" && m.kind == "message" && m.streaming);
                    let message_id = streaming_idx
                        .map(|i| v.messages[i].id.clone())
                        .unwrap_or_else(new_id);
                    let parts = history::message_parts(m, &message_id);
                    let final_msg = parts.into_iter().find(|p| p.kind == "message");
                    if let Some(mut part) = final_msg {
                        part.streaming = false;
                        part.status = if part.is_error { "error" } else { "completed" }.into();
                        if part.created_at == 0 {
                            part.created_at = streaming_idx
                                .map(|i| v.messages[i].created_at)
                                .filter(|t| *t > 0)
                                .unwrap_or_else(now_ms);
                        }
                        part.raw_kind = kind.clone();
                        part.source_event_id = None;
                        if let Some(idx) = streaming_idx {
                            v.messages[idx] = part;
                        } else {
                            v.messages.push(part);
                        }
                    } else if let Some(idx) = streaming_idx {
                        let empty = v.messages[idx].text.is_empty()
                            && v.messages[idx].thinking.is_empty()
                            && v.messages[idx].images.is_empty();
                        if empty {
                            v.messages.remove(idx);
                        } else {
                            v.messages[idx].streaming = false;
                            v.messages[idx].status = "completed".into();
                        }
                    }
                    if let Some(error) = m
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        v.error = Some(error.into());
                    }
                    if let Some(usage) = m.get("usage") {
                        v.context = build_context_value(usage, &v.model);
                    }
                } else if role == "user" {
                    let parts = history::message_parts(m, &new_id());
                    for mut part in parts {
                        if part.created_at == 0 {
                            part.created_at = now_ms();
                        }
                        part.raw_kind = "confirmed_user".into();
                        part.source_event_id = None;
                        if let Some(pending) = v.messages.iter_mut().find(|old| {
                            old.role == "user"
                                && old.raw_kind == "pending_user_echo"
                                && old.text == part.text
                                && old.images.len() == part.images.len()
                        }) {
                            pending.raw_kind = "confirmed_user".into();
                        } else if !v
                            .messages
                            .iter()
                            .rev()
                            .take(6)
                            .any(|old| old.role == "user" && old.text == part.text && old.images.len() == part.images.len())
                        {
                            v.messages.push(part);
                        }
                    }
                }
            }
            "tool_execution_start" => {
                v.messages.push(Message {
                    id: format!("tool:{}", text(&frame, "toolCallId")),
                    kind: "toolCall".into(),
                    role: "tool".into(),
                    tool_name: text(&frame, "toolName"),
                    tool_call_id: text(&frame, "toolCallId"),
                    arguments: frame.get("args").cloned().unwrap_or(Value::Null),
                    status: "running".into(),
                    created_at: now_ms(),
                    raw_kind: kind.clone(),
                    ..Message::default()
                });
            }
            "tool_execution_update" | "tool_execution_end" => {
                let call = text(&frame, "toolCallId");
                let output = frame
                    .get(if kind == "tool_execution_end" {
                        "result"
                    } else {
                        "partialResult"
                    })
                    .unwrap_or(&Value::Null);
                let result = history::content_text(output.get("content").unwrap_or(output));
                let diff = history::structured_diff(output.pointer("/details/diff"));
                let is_error = frame.get("isError") == Some(&json!(true));
                if let Some(tool) = v
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| m.tool_call_id == call && m.kind == "toolCall")
                {
                    if !result.is_empty() {
                        tool.text = result;
                    }
                    if diff.is_some() {
                        tool.diff = diff;
                    }
                    tool.is_error = is_error;
                    tool.status = if kind != "tool_execution_end" {
                        "running"
                    } else if is_error {
                        "error"
                    } else {
                        "completed"
                    }
                    .into();
                }
            }
            "extension_ui_request" => {
                let request_id = text(&frame, "id");
                let method = text(&frame, "method");
                if matches!(method.as_str(), "select" | "confirm" | "input" | "editor") {
                    if !v.pending_requests.iter().any(|p| p.id == request_id) {
                        v.pending_requests.push(PendingRequest {
                            id: request_id,
                            kind: method,
                            title: text(&frame, "title"),
                            message: text(&frame, "message"),
                            options: frame
                                .get("options")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                            default_value: frame
                                .get("prefill")
                                .or_else(|| frame.get("text"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .into(),
                        });
                    }
                } else if method == "notify" {
                    v.messages.push(Message {
                        id: new_id(),
                        kind: "notice".into(),
                        role: "system".into(),
                        text: text(&frame, "message"),
                        is_error: text(&frame, "notifyType") == "error",
                        created_at: now_ms(),
                        raw_kind: kind.clone(),
                        ..Message::default()
                    });
                } else if method == "setStatus" {
                    let key = text(&frame, "statusKey");
                    if !key.is_empty() {
                        if let Some(val) = frame.get("statusText").and_then(Value::as_str) {
                            v.statuses.insert(key, json!(val));
                        } else {
                            v.statuses.remove(&key);
                        }
                    }
                } else if method == "setWidget" {
                    let key = text(&frame, "widgetKey");
                    if !key.is_empty() {
                        if let Some(lines) = frame.get("widgetLines").and_then(Value::as_array) {
                            let joined = lines
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n");
                            v.statuses.insert(format!("widget:{key}"), json!(joined));
                        } else {
                            v.statuses.remove(&format!("widget:{key}"));
                        }
                    }
                }
            }
            "extension_error" => {
                let err = text(&frame, "error");
                if !err.is_empty() {
                    v.messages.push(Message {
                        id: new_id(),
                        kind: "notice".into(),
                        role: "system".into(),
                        text: format!("扩展报错：{err}"),
                        is_error: true,
                        created_at: now_ms(),
                        raw_kind: kind.clone(),
                        ..Message::default()
                    });
                }
            }
            "agent_end" => {
                finished = v.busy();
                v.state = "idle".into();
                for m in &mut v.messages {
                    m.streaming = false;
                }
            }
            "agent_settled" => {
                if !v.busy() {
                    if let Some(error) = frame
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        v.error = Some(error.into());
                    }
                }
            }
            "auto_compaction_start" | "compaction_start" => {
                v.state = "compacting".into();
            }
            "auto_compaction_end" | "compaction_end" => {
                v.state = "idle".into();
                finished = !v.queue.is_empty();
            }
            "auto_retry_start" => {
                v.state = "working".into();
            }
            "auto_retry_end" => {
                if frame.get("success") == Some(&json!(false)) {
                    let err = text(&frame, "finalError");
                    if !err.is_empty() {
                        v.error = Some(err);
                    }
                }
            }
            "host_protocol_error" => {
                v.error = Some(text(&frame, "error"));
                v.state = "crashed".into();
            }
            _ => {}
        });
        if finished {
            self.turn_finished(id, runtime);
        }
    }
    pub fn turn_finished(self: &Arc<Self>, id: &str, runtime: &Arc<Runtime>) {
        let _ = self.persist(id);
        let host = self.clone();
        let id = id.to_string();
        let runtime = runtime.clone();
        tokio::spawn(async move {
            let _gate = runtime.gate.lock().await;
            if runtime.bridge.wire == Wire::Pi {
                let _ = host.refresh_pi(&id, &runtime, false).await;
                if let Ok(view) = host.view(&id) {
                    if let Some(path) = view.binding.native_session_path {
                        if let Ok((entries, _)) = tokio::task::spawn_blocking(move || {
                            history::pi_tail_summary(std::path::Path::new(&path))
                        })
                        .await
                        {
                            host.update(&id, Some(&runtime.instance), |v| {
                                for (entry_id, role, entry_text) in entries {
                                    if let Some(current) = v.messages.iter_mut().rev().find(|m| {
                                        m.source_event_id.is_none()
                                            && m.role == role
                                            && m.text == entry_text
                                    }) {
                                        current.source_event_id = Some(entry_id);
                                    }
                                }
                            });
                        }
                    }
                }
            }
            let next = {
                let mut state = lock(&host.state);
                state
                    .sessions
                    .get_mut(&id)
                    .filter(|v| {
                        v.instance_id.as_deref() == Some(runtime.instance.as_str())
                            && !v.busy()
                            && v.error.is_none()
                    })
                    .and_then(|v| {
                        if v.queue.is_empty() {
                            None
                        } else {
                            v.state = "working".into();
                            Some(v.queue.remove(0))
                        }
                    })
            };
            if let Some(next) = next {
                host.schedule_prompt(id, next);
            }
        });
    }
}
