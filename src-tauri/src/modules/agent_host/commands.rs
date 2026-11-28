//! Top-level command router and session command handlers for `agent_host`.
//! Domain-specific handlers live in `admin_commands.rs`, `vcs_commands.rs`, and runtime
//! execution delegates to `adapter.rs`.

use super::{
    adapter::{HarnessAdapter, SessionPhase, INTERACTIVE_PROMPT_TIMEOUT, QUERY_TIMEOUT},
    bridge::{lock, Wire},
    coordinator::{CachedRequest, Host, Runtime},
    protocol::*,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

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
        if is_read_only_operation(command.operation.as_str()) {
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
            op if op.starts_with("workspace.") => {
                self.execute_workspace_command(principal, &command).await
            }
            op if op.starts_with("harness.")
                || op.starts_with("pi.")
                || op.starts_with("usage.") =>
            {
                self.execute_harness_and_settings_command(principal, &command)
                    .await
            }
            op if op.starts_with("host.") => {
                self.execute_host_admin_command(principal, &command).await
            }
            op if op.starts_with("vcs.") || op.starts_with("forge.") => {
                self.execute_vcs_or_forge(principal, &command).await
            }
            op if op.starts_with("session.")
                || matches!(op, "runtime.subscribe" | "permission.respond" | "extension.respond") =>
            {
                self.execute_session_command(principal, &command).await
            }
            _ => Err(format!("不支持的主机操作：{operation}")),
        }
    }

    async fn execute_session_command(
        self: &Arc<Self>,
        principal: &Principal,
        command: &Command,
    ) -> Result<Value, String> {
        let operation = command.operation.as_str();
        let payload = &command.payload;
        match operation {
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
                self.ensure_runtime_for_prompt(id).await?;
                let _gate = self.provider_gate.read().await;
                self.accept_prompt(id, payload.clone())?;
                Ok(json!({"accepted": true}))
            }
            "session.cancel" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let runtime = lock(&self.runtimes)
                    .get(id)
                    .cloned()
                    .ok_or("会话没有运行")?;
                self.adapter_cancel_turn(id, runtime).await?;
                Ok(json!({}))
            }
            "session.queue.flush" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.ensure_runtime_for_prompt(id).await?;
                let next = {
                    let mut state = lock(&self.state);
                    state
                        .sessions
                        .get_mut(id)
                        .filter(|v| !v.busy() && !v.queue.is_empty())
                        .map(|v| {
                            v.state = SessionPhase::Working.as_str().into();
                            v.error = None;
                            v.queue.remove(0)
                        })
                };
                if let Some(next) = next {
                    self.schedule_prompt(id.to_string(), next);
                    return Ok(json!({ "flushed": true }));
                }
                Ok(json!({ "flushed": false }))
            }
            "session.queue.clear" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.update(id, None, |v| v.queue.clear());
                Ok(json!({}))
            }
            "session.queue.remove" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                let idx = payload
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize);
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
                let idx = payload
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize);
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
                let idx = payload
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize);
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
                    if self.adapter_steer_prompt(id, &runtime, item.clone()).await? {
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
                                .request("set_session_name", json!({"name": title}), QUERY_TIMEOUT)
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
                if view.binding.imported
                    || view.messages.iter().any(|message| message.role == "user")
                {
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
                Ok(json!({"discarded": true}))
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
                        let _ = self.save_setting_preference(
                            id,
                            runtime.bridge.wire,
                            &view,
                            operation,
                            payload,
                            true,
                        );
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
                        let _ = self.save_setting_preference(
                            id,
                            runtime.bridge.wire,
                            &view,
                            operation,
                            payload,
                            true,
                        );
                        let updated = self.view(id)?;
                        return Ok(json!({
                            "deferred": true,
                            "model": updated.model,
                            "thinkingLevel": updated.thinking_level,
                        }));
                    }
                    return Err("当前会话正在运行，请稍后更改配置".into());
                }
                let result = self
                    .apply_session_setting(id, &runtime, operation, payload)
                    .await?;
                if matches!(
                    operation,
                    "session.model" | "session.thinking" | "session.config"
                ) {
                    let _ = self.save_setting_preference(
                        id,
                        runtime.bridge.wire,
                        &view,
                        operation,
                        payload,
                        true,
                    );
                }
                Ok(result)
            }
            "session.fork" => {
                principal.require_desktop()?;
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.fork_pi_session(id, payload).await
            }
            "permission.respond" | "extension.respond" => {
                let id = command.session_id.as_deref().ok_or("缺少会话标识")?;
                self.adapter_respond_pending(id, payload).await?;
                Ok(json!({}))
            }
            _ => Err(format!("不支持的会话操作：{operation}")),
        }
    }

    async fn fork_pi_session(
        self: &Arc<Self>,
        id: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let source = self.view(id)?;
        let adapter = HarnessAdapter::for_harness_id(&source.binding.harness_id);
        if !adapter.supports_native_fork() || source.busy() {
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
            .request(rpc_method, rpc_params, QUERY_TIMEOUT)
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
            .request("set_session_name", json!({"name": title}), QUERY_TIMEOUT)
            .await?;
        self.update(&next, Some(&runtime.instance), |v| {
            v.binding.read_only = false;
            v.binding.title = title;
        });
        self.persist(&next)?;
        Ok(json!(self.view(&next)?))
    }

    pub fn accept_prompt(self: &Arc<Self>, id: &str, payload: Value) -> Result<(), String> {
        let runtime = lock(&self.runtimes).get(id).cloned().ok_or("代理未连接")?;
        let _gate = runtime
            .gate
            .try_lock()
            .map_err(|_| "正在应用会话配置，请稍后发送")?;
        let msg_text = text(&payload, "text");
        let images = payload
            .get("images")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        validate_prompt_payload(&msg_text, &images)?;
        {
            let mut state = lock(&self.state);
            let view = state.sessions.get_mut(id).ok_or("会话不存在")?;
            if view.binding.read_only {
                return Err("此历史当前只读".into());
            }
            if !images.is_empty() && !view.capabilities.supports_images {
                return Err("当前代理没有声明图片能力".into());
            }
            let adapter = HarnessAdapter::for_wire(runtime.bridge.wire, &view.binding.harness_id);
            if view.busy() {
                let mut item = payload;
                if let Some(obj) = item.as_object_mut() {
                    obj.entry("id").or_insert_with(|| json!(new_id()));
                }
                if item.get("steer").and_then(Value::as_bool) == Some(true)
                    && adapter.supports_live_steer(&runtime)
                {
                    if adapter == HarnessAdapter::Pi {
                        let runtime_cloned = runtime.clone();
                        let host_cloned = self.clone();
                        let sid = id.to_string();
                        let steer_text = msg_text.clone();
                        let imgs = images.clone();
                        tokio::spawn(async move {
                            let _ = runtime_cloned
                                .bridge
                                .request(
                                    "steer",
                                    json!({ "message": steer_text, "images": imgs }),
                                    INTERACTIVE_PROMPT_TIMEOUT,
                                )
                                .await;
                            host_cloned.update(&sid, Some(&runtime_cloned.instance), |v| {
                                v.messages.push(Message {
                                    id: new_id(),
                                    kind: "message".into(),
                                    role: "user".into(),
                                    text: steer_text,
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
                    view.revision += 1;
                    state.dirty.insert(id.into());
                    drop(state);
                    self.schedule_prompt(id.into(), item);
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
            view.state = SessionPhase::Working.as_str().into();
            view.binding.archived = false;
            view.error = None;
            view.revision += 1;
            state.dirty.insert(id.into());
        }
        self.schedule_prompt(id.into(), payload);
        Ok(())
    }

    pub fn spawn_cancel_watchdog(
        self: &Arc<Self>,
        id: String,
        runtime: Arc<Runtime>,
        cancel_token: u64,
        timeout: Duration,
    ) {
        let host = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            if runtime.closing.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            if runtime.cancel_seq.load(std::sync::atomic::Ordering::Acquire) != cancel_token {
                return;
            }
            let still_stopping = host.view(&id).is_ok_and(|v| {
                v.instance_id.as_deref() == Some(runtime.instance.as_str())
                    && v.state == SessionPhase::Stopping.as_str()
            });
            if still_stopping {
                host.runtime_failed(
                    &id,
                    &runtime,
                    "停止当前回合超时，已断开该代理进程，可重新发送消息以重连",
                );
            }
        });
    }

    pub fn schedule_prompt(self: &Arc<Self>, id: String, payload: Value) {
        let host = self.clone();
        let instance = self.view(&id).ok().and_then(|v| v.instance_id);
        tokio::spawn(async move {
            if let Err(error) = host.prompt_now(&id, payload).await {
                host.update(&id, instance.as_deref(), |v| {
                    if !error.ends_with("响应超时") && !error.contains("长时间无响应") {
                        v.state = SessionPhase::Idle.as_str().into();
                        for m in &mut v.messages {
                            m.streaming = false;
                        }
                    }
                    v.error = Some(error.clone());
                });
            }
        });
    }

    fn acp_setting_kind(
        view: &SessionView,
        operation: &str,
        payload: &Value,
    ) -> Result<(String, String), String> {
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
        let adapter = HarnessAdapter::for_harness_id(&view.binding.harness_id);
        if config_id.is_empty()
            && operation == "session.thinking"
            && adapter.supports_codex_thinking_fallback()
        {
            if value.is_empty()
                || (!view.thinking_levels.is_empty() && !view.thinking_levels.contains(&value))
            {
                return Err("该模型不支持此思考等级".into());
            }
            return Ok(("__codex_thinking__".into(), value));
        }
        if config_id.is_empty()
            || !view
                .config_options
                .iter()
                .any(|c| text(c, "id") == config_id)
        {
            return Err("该代理没有声明此配置选项".into());
        }
        Ok((config_id, value))
    }

    #[cfg(test)]
    pub(super) fn acp_setting_kind_for_test(
        view: &SessionView,
        operation: &str,
        payload: &Value,
    ) -> Result<(String, String), String> {
        Self::acp_setting_kind(view, operation, payload)
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
                    if !view
                        .models
                        .iter()
                        .any(|m| text(m, "provider") == provider && text(m, "id") == model)
                    {
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
            drop(pending);
            self.update(id, Some(&runtime.instance), |v| match operation {
                "session.model" => {
                    let provider = text(payload, "provider");
                    let model = text(payload, "modelId");
                    if let Some(found) = v
                        .models
                        .iter()
                        .find(|m| text(m, "provider") == provider && text(m, "id") == model)
                        .cloned()
                    {
                        v.model = Some(found);
                    }
                }
                "session.thinking" => {
                    v.thinking_level = text(payload, "level");
                }
                _ => {}
            });
            return Ok(());
        }
        let (config_id, value) = Self::acp_setting_kind(&view, operation, payload)?;
        let mut pending = lock(&runtime.pending_config);
        match operation {
            "session.model" => {
                pending.model = Some((String::new(), value.clone()));
            }
            "session.thinking" => {
                pending.thinking = Some(value.clone());
            }
            _ => {
                if let Some(existing) = pending.configs.iter_mut().find(|(cid, _)| cid == &config_id)
                {
                    existing.1 = value.clone();
                } else {
                    pending.configs.push((config_id.clone(), value.clone()));
                }
            }
        }
        drop(pending);
        self.update(id, Some(&runtime.instance), |v| {
            if operation == "session.model" {
                if let Some(found) = v.models.iter().find(|m| text(m, "id") == value).cloned() {
                    v.model = Some(found);
                }
            } else if operation == "session.thinking" {
                v.thinking_level = value.clone();
            } else if let Some(opt) = v
                .config_options
                .iter_mut()
                .find(|c| text(c, "id") == config_id)
            {
                if let Some(obj) = opt.as_object_mut() {
                    obj.insert("currentValue".into(), json!(value));
                }
            }
        });
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
                    if !self
                        .view(id)?
                        .models
                        .iter()
                        .any(|m| text(m, "provider") == provider && text(m, "id") == model)
                    {
                        return Err("模型不在当前 Pi 运行时清单中".into());
                    }
                    lock(&runtime.pending_config).model = None;
                    ("set_model", json!({"provider": provider, "modelId": model}))
                }
                "session.thinking" => {
                    let level = text(payload, "level");
                    if !self.view(id)?.thinking_levels.contains(&level) {
                        return Err("该模型不支持此思考等级".into());
                    }
                    lock(&runtime.pending_config).thinking = None;
                    ("set_thinking_level", json!({"level": level}))
                }
                "session.compact" => (
                    "compact",
                    json!({"customInstructions": payload.get("instructions")}),
                ),
                "session.commands" => ("get_commands", json!({})),
                _ => return Err("Pi 使用原生模型和思考等级设置".into()),
            };
            if operation == "session.compact" {
                self.update(id, Some(&runtime.instance), |v| {
                    v.state = SessionPhase::Compacting.as_str().into()
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
                        QUERY_TIMEOUT
                    },
                )
                .await;
            if operation == "session.compact" {
                self.update(id, Some(&runtime.instance), |v| {
                    v.state = SessionPhase::Idle.as_str().into()
                });
            }
            let result = result?;
            self.refresh_pi(id, runtime, operation == "session.compact")
                .await?;
            if operation == "session.model" {
                Ok(json!({"model": self.view(id)?.model}))
            } else {
                Ok(result)
            }
        } else {
            let view = self.view(id)?;
            if operation == "session.compact" {
                return Err("该代理没有声明压缩能力".into());
            }
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
                        json!({"sessionId": native, "modelId": value}),
                        QUERY_TIMEOUT,
                    )
                    .await?;
                self.update(id, Some(&runtime.instance), |v| {
                    v.model = v.models.iter().find(|m| text(m, "id") == value).cloned()
                });
                return Ok(result);
            }
            if config_id == "__codex_thinking__" {
                lock(&runtime.pending_config).thinking = None;
                return self.apply_codex_thinking_fallback(id, runtime, &value).await;
            }
            if operation == "session.model" {
                let model_id = text(payload, "modelId");
                let selected_model = view.models.iter().find(|m| text(m, "id") == model_id);
                let target_value = selected_model
                    .and_then(|m| m.get("acpValue"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| model_id.clone());
                lock(&runtime.pending_config).model = None;
                let res = self
                    .set_acp_config(id, runtime, &config_id, &target_value)
                    .await?;
                if let Some(model_obj) = selected_model.cloned() {
                    self.update(id, Some(&runtime.instance), |v| {
                        v.model = Some(model_obj);
                    });
                }
                return Ok(res);
            }
            {
                let mut pending = lock(&runtime.pending_config);
                if operation == "session.thinking" {
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
            || view.config_options.iter().any(|c| {
                text(c, "id") == config_id
                    && (text(c, "category") == "model" || text(c, "id") == "model")
            });
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
            v.state = SessionPhase::Working.as_str().into();
            v.error = None;
            v.statuses.remove("turnGit");
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
        let turn_id = new_id();
        self.vcs.suppress_turn_baseline(id, &turn_id);
        let baseline_task = if self.vcs_background_enabled() {
            self.session_cwd(id).and_then(|cwd| {
                if self.vcs.begin_turn_baseline(id, &turn_id, &cwd) {
                    None
                } else {
                    Some((cwd, turn_id.clone()))
                }
            })
        } else {
            None
        };
        if let Some((cwd, tid)) = baseline_task {
            let vcs = self.vcs.clone();
            let sid = id.to_string();
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(Some(snap)) = vcs.snapshot(&cwd) {
                        vcs.record_turn_baseline_from_snapshot(&sid, &tid, snap);
                    }
                })
                .await;
            });
        }
        {
            let _gate = runtime.gate.lock().await;
            self.apply_pending_config(id, &runtime).await?;
        }
        self.capture_initial_session_preferences(id);
        self.adapter_execute_prompt(id, &runtime, &turn_id, message, images)
            .await
    }

    fn capture_initial_session_preferences(&self, id: &str) {
        let Ok(snapshot) = self.view(id) else {
            return;
        };
        if snapshot.binding.read_only {
            return;
        }
        let model_id = snapshot
            .model
            .as_ref()
            .map(|m| text(m, "id"))
            .filter(|s| !s.is_empty());
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
                prefs
                    .configs
                    .entry(cid.clone())
                    .or_insert_with(|| val.clone());
            }
        });
    }
}

fn validate_prompt_payload(text: &str, images: &[Value]) -> Result<(), String> {
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
    Ok(())
}

fn is_read_only_operation(operation: &str) -> bool {
    matches!(
        operation,
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
            | "vcs.snapshot"
            | "vcs.diff"
            | "vcs.branches"
            | "vcs.log"
            | "vcs.commit.detail"
            | "vcs.commit.diff"
            | "vcs.stash.list"
            | "vcs.worktree.list"
            | "vcs.conflict.versions"
            | "vcs.doctor.check"
            | "vcs.turn.diff"
            | "forge.repos"
            | "forge.inbox"
            | "forge.comments"
            | "forge.pr.checks"
            | "forge.pr.files"
            | "forge.auth.status"
            | "forge.image"
    )
}
