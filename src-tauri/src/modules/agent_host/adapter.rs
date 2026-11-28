//! Adapter abstraction layer unifying Pi native RPC and ACP (Codex / Antigravity / custom)
//! runtimes, eliminating scattered `harness_id == "..."` branches and `Wire` conditionals.

use super::{
    bridge::{lock, Wire},
    coordinator::{Host, Runtime},
    protocol::*,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub(super) const QUERY_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const INTERACTIVE_PROMPT_TIMEOUT: Duration = Duration::from_secs(900);
pub(super) const ACP_CANCEL_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const ACP_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Explicit session lifecycle state transitions enforced by the coordinator.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPhase {
    Idle,
    Working,
    Stopping,
    Compacting,
    Crashed,
}

#[allow(dead_code)]
impl SessionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Stopping => "stopping",
            Self::Compacting => "compacting",
            Self::Crashed => "crashed",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "working" | "streaming" | "starting" => Self::Working,
            "stopping" => Self::Stopping,
            "compacting" => Self::Compacting,
            "crashed" => Self::Crashed,
            _ => Self::Idle,
        }
    }

    pub fn is_busy(self) -> bool {
        matches!(self, Self::Working | Self::Stopping | Self::Compacting)
    }
}

/// Canonical harness adapter family — single source of truth for per-harness policy differences.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarnessAdapter {
    Pi,
    Codex,
    Antigravity,
    GenericAcp,
}

#[allow(dead_code)]
impl HarnessAdapter {
    pub fn for_harness_id(harness_id: &str) -> Self {
        match harness_id {
            "pi" => Self::Pi,
            "acp:codex" => Self::Codex,
            "acp:antigravity" => Self::Antigravity,
            _ => Self::GenericAcp,
        }
    }

    pub fn for_wire(wire: Wire, harness_id: &str) -> Self {
        if wire == Wire::Pi {
            Self::Pi
        } else {
            Self::for_harness_id(harness_id)
        }
    }

    pub fn wire(self) -> Wire {
        match self {
            Self::Pi => Wire::Pi,
            Self::Codex | Self::Antigravity | Self::GenericAcp => Wire::Acp,
        }
    }

    /// Whether the adapter supports live steering while a turn is running.
    pub fn supports_live_steer(self, runtime: &Runtime) -> bool {
        match self {
            Self::Pi => true,
            _ => runtime
                .supports_prompt_steer
                .load(std::sync::atomic::Ordering::Acquire),
        }
    }

    /// Whether the adapter provides workspace-local skill discovery via host filesystem.
    pub fn supports_workspace_skill_scan(self) -> bool {
        matches!(self, Self::Antigravity)
    }

    /// Whether thinking level can fall back to Codex config when no ACP config option is declared.
    pub fn supports_codex_thinking_fallback(self) -> bool {
        matches!(self, Self::Codex)
    }

    /// Whether this adapter supports session fork/clone via native RPC.
    pub fn supports_native_fork(self) -> bool {
        matches!(self, Self::Pi)
    }

    /// Whether this adapter supports session compaction.
    pub fn supports_compact(self) -> bool {
        matches!(self, Self::Pi)
    }
}

/// Runtime dispatch helpers delegated through `HarnessAdapter` so command handlers stay clean.
impl Host {
    /// Cancel all pending interactive approvals/UI requests and dispatch runtime cancel/abort.
    pub(super) async fn adapter_cancel_turn(
        self: &Arc<Self>,
        id: &str,
        runtime: Arc<Runtime>,
    ) -> Result<(), String> {
        let view = self.view(id)?;
        let adapter = HarnessAdapter::for_wire(runtime.bridge.wire, &view.binding.harness_id);
        let cancel_token = {
            let _replies = runtime.reply_gate.lock().await;
            runtime
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release);
            let token = runtime
                .cancel_seq
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                + 1;
            for (_, tx) in lock(&runtime.fs_approvals).drain() {
                let _ = tx.send(false);
            }
            match adapter {
                HarnessAdapter::Pi => {
                    for request in self.view(id)?.pending_requests {
                        let _ = runtime.bridge.send(json!({
                            "type": "extension_ui_response",
                            "id": request.id,
                            "cancelled": true
                        }));
                    }
                }
                _ => {
                    for (_, native) in lock(&runtime.permission_ids).drain() {
                        let _ = runtime.bridge.send(json!({
                            "jsonrpc": "2.0",
                            "id": native,
                            "result": { "outcome": { "outcome": "cancelled" } }
                        }));
                    }
                }
            }
            self.update(id, Some(&runtime.instance), |v| {
                v.state = SessionPhase::Stopping.as_str().into();
                v.queue.clear();
                v.pending_requests.clear();
            });
            token
        };

        let result = match adapter {
            HarnessAdapter::Pi => runtime
                .bridge
                .request("abort", json!({}), QUERY_TIMEOUT)
                .await
                .map(|_| ()),
            _ => {
                let native = lock(&runtime.native_id).clone();
                runtime.bridge.send(json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": { "sessionId": native }
                }))
            }
        };

        if let Err(e) = result {
            self.update(id, Some(&runtime.instance), |v| {
                v.error = Some(e.clone());
                v.state = SessionPhase::Idle.as_str().into();
            });
            return Err(e);
        }

        match adapter {
            HarnessAdapter::Pi => {
                self.update(id, Some(&runtime.instance), |v| {
                    if v.state == SessionPhase::Stopping.as_str() {
                        v.state = SessionPhase::Idle.as_str().into();
                    }
                });
                self.turn_finished(id, &runtime);
            }
            _ => {
                self.spawn_cancel_watchdog(
                    id.to_string(),
                    runtime,
                    cancel_token,
                    ACP_CANCEL_TIMEOUT,
                );
            }
        }
        Ok(())
    }

    /// Steer an active turn with an urgent user prompt; returns `Ok(true)` if steered live.
    pub(super) async fn adapter_steer_prompt(
        self: &Arc<Self>,
        id: &str,
        runtime: &Arc<Runtime>,
        item: Value,
    ) -> Result<bool, String> {
        let view = self.view(id)?;
        let adapter = HarnessAdapter::for_wire(runtime.bridge.wire, &view.binding.harness_id);
        match adapter {
            HarnessAdapter::Pi => {
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
                        INTERACTIVE_PROMPT_TIMEOUT,
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
                Ok(true)
            }
            _ if adapter.supports_live_steer(runtime) => {
                self.schedule_prompt(id.into(), item);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Execute a prompt against the underlying Pi or ACP runtime bridge.
    pub(super) async fn adapter_execute_prompt(
        self: &Arc<Self>,
        id: &str,
        runtime: &Arc<Runtime>,
        turn_id: &str,
        message: String,
        images: Vec<Value>,
    ) -> Result<(), String> {
        if runtime.bridge.wire == Wire::Pi {
            if let Ok(state) = runtime.bridge.request("get_state", json!({}), QUERY_TIMEOUT).await {
                if state.get("isStreaming") == Some(&json!(true)) {
                    let _ = runtime.bridge.request("abort", json!({}), QUERY_TIMEOUT).await;
                }
            }
            let reply = match runtime
                .bridge
                .request(
                    "prompt",
                    json!({"message": message, "images": images}),
                    INTERACTIVE_PROMPT_TIMEOUT,
                )
                .await
            {
                Ok(reply) => reply,
                Err(e) => {
                    self.vcs.suppress_turn_baseline(id, turn_id);
                    return Err(e);
                }
            };
            if reply.get("disposition").and_then(Value::as_str) == Some("handled") {
                let state = match runtime.bridge.request("get_state", json!({}), QUERY_TIMEOUT).await {
                    Ok(state) => state,
                    Err(e) => {
                        self.vcs.suppress_turn_baseline(id, turn_id);
                        return Err(e);
                    }
                };
                if state.get("isStreaming") != Some(&json!(true))
                    && state.get("isCompacting") != Some(&json!(true))
                {
                    self.update(id, Some(&runtime.instance), |v| {
                        if v.state == SessionPhase::Working.as_str() {
                            v.state = SessionPhase::Idle.as_str().into();
                        }
                    });
                    self.turn_finished(id, runtime);
                }
            }
            return Ok(());
        }

        let native = lock(&runtime.native_id).clone().ok_or("代理尚未初始化")?;
        let mut prompt = vec![json!({"type": "text", "text": message})];
        for image in images {
            prompt.push(json!({
                "type": "image",
                "data": image.get("data"),
                "mimeType": image.get("mimeType"),
            }));
        }
        runtime.touch_activity();
        runtime
            .active_prompts
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let mut req_fut = Box::pin(runtime.bridge.request(
            "session/prompt",
            json!({"sessionId": native, "prompt": prompt}),
            Duration::from_secs(24 * 3600),
        ));
        let inactivity_ms = ACP_INACTIVITY_TIMEOUT.as_millis() as u64;
        let mut poll = tokio::time::interval(Duration::from_secs(15));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let reply = loop {
            tokio::select! {
                res = &mut req_fut => break res,
                _ = poll.tick() => {
                    if runtime.closing.load(std::sync::atomic::Ordering::Acquire) {
                        break Err("代理已停止".into());
                    }
                    let waiting_user = !lock(&runtime.permission_ids).is_empty()
                        || !lock(&runtime.fs_approvals).is_empty();
                    if waiting_user {
                        runtime.touch_activity();
                        continue;
                    }
                    let last = runtime.last_activity_ms.load(std::sync::atomic::Ordering::Acquire);
                    if now_ms().saturating_sub(last) >= inactivity_ms {
                        let err = "代理长时间无响应（超过 15 分钟未收到输出），已断开，请重新发送消息".to_string();
                        runtime.active_prompts.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                        self.vcs.suppress_turn_baseline(id, turn_id);
                        self.runtime_failed(id, runtime, &err);
                        return Err(err);
                    }
                }
            }
        };
        let prev_prompts = runtime
            .active_prompts
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        let is_outermost = prev_prompts <= 1;
        if is_outermost {
            runtime
                .cancel_seq
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let was_cancelled = runtime
                .cancelled
                .swap(false, std::sync::atomic::Ordering::AcqRel);
            self.update(id, Some(&runtime.instance), |v| {
                v.state = SessionPhase::Idle.as_str().into();
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
                Ok(_) => self.turn_finished(id, runtime),
                Err(_) if was_cancelled => self.turn_finished(id, runtime),
                Err(e) => {
                    self.vcs.suppress_turn_baseline(id, turn_id);
                    return Err(super::acp::format_acp_error(
                        &e,
                        &runtime.bridge.diagnostic_tail(),
                    ));
                }
            }
        } else if let Err(e) = reply {
            if !runtime.cancelled.load(std::sync::atomic::Ordering::Acquire) {
                return Err(super::acp::format_acp_error(
                    &e,
                    &runtime.bridge.diagnostic_tail(),
                ));
            }
        }
        Ok(())
    }

    /// Respond to a pending permission or extension UI request for the session.
    pub(super) async fn adapter_respond_pending(
        &self,
        id: &str,
        payload: &Value,
    ) -> Result<(), String> {
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
            runtime.bridge.send(json!({
                "type": "extension_ui_response",
                "id": request_id,
                "value": payload.get("value"),
                "confirmed": payload.get("confirmed"),
                "cancelled": cancelled,
            }))?;
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
                json!({"outcome": "cancelled"})
            } else {
                json!({"outcome": "selected", "optionId": option})
            };
            runtime
                .bridge
                .send(json!({"jsonrpc": "2.0", "id": native, "result": {"outcome": outcome}}))?;
        }
        self.update(id, Some(&runtime.instance), |v| {
            v.pending_requests.retain(|p| p.id != request_id)
        });
        Ok(())
    }
}
