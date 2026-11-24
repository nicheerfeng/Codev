use super::{
    bridge::{lock, Bridge, Wire},
    coordinator::{Host, PendingRuntimeConfig, Runtime},
    history,
    protocol::*,
    registry,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tempfile::TempDir;

fn test_host(dir: &TempDir) -> Arc<Host> {
    Host::open(dir.path().join("host"), dir.path().join("web")).expect("open host")
}

fn attach_runtime(host: &Arc<Host>, sid: &str, wire: Wire) -> (Arc<Runtime>, std::sync::mpsc::Receiver<serde_json::Value>) {
    let (bridge, rx) = Bridge::for_test(wire);
    let runtime = Arc::new(Runtime {
        instance: "inst-1".into(),
        bridge,
        native_id: Mutex::new(Some("native-1".into())),
        gate: tokio::sync::Mutex::new(()),
        reply_gate: tokio::sync::Mutex::new(()),
        permission_ids: Mutex::new(HashMap::new()),
        fs_approvals: Mutex::new(HashMap::new()),
        session_auto_write: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        closing: AtomicBool::new(false),
        loading_history: AtomicBool::new(false),
        loading_desktop_history: AtomicBool::new(false),
        pending_config: Mutex::new(PendingRuntimeConfig::default()),
    });
    lock(&host.runtimes).insert(sid.into(), runtime.clone());
    host.update(sid, None, |v| {
        v.instance_id = Some("inst-1".into());
        v.state = "idle".into();
        v.model = Some(json!({ "id": "m1", "contextWindow": 1000 }));
    });
    (runtime, rx)
}

#[tokio::test]
async fn pi_delta_streaming_tool_only_cleanup_and_empty_error_do_not_block() {
    let dir = TempDir::new().expect("tmp");
    let host = test_host(&dir);
    let ws_dir = dir.path().join("repo");
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws = host.workspace(&ws_dir.to_string_lossy()).unwrap();
    let sid = host.create(&ws.id, "pi", "demo").unwrap();
    let (runtime, _rx) = attach_runtime(&host, &sid, Wire::Pi);

    host.handle_frame(&sid, &runtime, json!({"type": "agent_start"}));
    host.handle_frame(
        &sid,
        &runtime,
        json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
    );
    host.handle_frame(
        &sid,
        &runtime,
        json!({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "step1 "}}),
    );
    host.handle_frame(
        &sid,
        &runtime,
        json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": "hello"}}),
    );
    host.handle_frame(
        &sid,
        &runtime,
        json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": " world"}}),
    );

    let mid = host.view(&sid).unwrap();
    let streaming = mid
        .messages
        .iter()
        .find(|m| m.role == "assistant")
        .expect("streaming msg");
    assert!(streaming.streaming);
    assert_eq!(streaming.thinking, "step1 ");
    assert_eq!(streaming.text, "hello world");

    // Finalize with empty errorMessage (must stay None) + usage including output tokens
    host.handle_frame(
        &sid,
        &runtime,
        json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "errorMessage": "",
                "content": [
                    {"type": "thinking", "thinking": "step1 "},
                    {"type": "text", "text": "hello world"}
                ],
                "usage": {"input": 100, "output": 50, "cacheRead": 25, "cacheWrite": 25}
            }
        }),
    );
    // Start a second turn that ONLY yields a toolCall in message_end -> no dangling streaming placeholder
    host.handle_frame(
        &sid,
        &runtime,
        json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
    );
    host.handle_frame(
        &sid,
        &runtime,
        json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": "tc-1", "name": "edit", "arguments": {"path": "a.rs"}}]
            }
        }),
    );
    host.handle_frame(&sid, &runtime, json!({"type": "tool_execution_start", "toolCallId": "tc-1", "toolName": "edit", "args": {"path": "a.rs"}}));
    host.handle_frame(&sid, &runtime, json!({
        "type": "tool_execution_end",
        "toolCallId": "tc-1",
        "isError": false,
        "result": {
            "content": [{"type": "text", "text": "Edited a.rs"}],
            "details": {"diff": "@@ -1 +1 @@\n-old\n+new"}
        }
    }));
    host.handle_frame(&sid, &runtime, json!({"type": "agent_end"}));

    let view = host.view(&sid).unwrap();
    assert!(view.error.is_none(), "empty errorMessage must not populate v.error");
    assert_eq!(view.context["tokens"], json!(200));
    assert!(!view.messages.iter().any(|m| m.streaming));
    assert_eq!(view.messages.iter().filter(|m| m.role == "assistant").count(), 1);
    let tool = view.messages.iter().find(|m| m.tool_call_id == "tc-1").unwrap();
    assert_eq!(tool.diff, Some(json!({"patch": "@@ -1 +1 @@\n-old\n+new"})));
}

#[test]
fn pi_and_codex_history_pair_tools_and_parse_timestamps() {
    let dir = TempDir::new().expect("tmp");
    let pi_file = dir.path().join("pi.jsonl");
    let pi_lines = [
        json!({"type":"session","id":"s1","cwd":"/repo","timestamp":"2026-11-22T10:00:00Z"}),
        json!({"type":"message","id":"e1","parentId":null,"timestamp":"2026-11-22T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}),
        json!({"type":"message","id":"e2","parentId":"e1","timestamp":"2026-11-22T10:00:02Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"src/lib.rs"}}]}}),
        json!({"type":"message","id":"e3","parentId":"e2","timestamp":"2026-11-22T10:00:03Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"fn main() {}"}],"details":{"diff":"@@ ok"}}}),
    ];
    std::fs::write(
        &pi_file,
        pi_lines.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n"),
    )
    .unwrap();
    let (pi_msgs, _) = history::read_pi(&pi_file, None).unwrap();
    assert_eq!(pi_msgs.len(), 2, "toolCall and toolResult must merge into one item");
    assert_eq!(pi_msgs[1].kind, "toolCall");
    assert_eq!(pi_msgs[1].text, "fn main() {}");
    assert_eq!(pi_msgs[1].diff, Some(json!({"patch": "@@ ok"})));
    assert!(pi_msgs[0].created_at > 0);

    let codex_file = dir.path().join("codex.jsonl");
    let codex_lines = [
        json!({"type":"response_item","timestamp":"2026-11-22T10:05:00Z","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"internal"}]}}),
        json!({"type":"response_item","timestamp":"2026-11-22T10:05:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix bug"}]}}),
        json!({"type":"response_item","timestamp":"2026-11-22T10:05:02Z","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"checking code"}]}}),
        json!({"type":"response_item","timestamp":"2026-11-22T10:05:03Z","payload":{"type":"custom_tool_call","call_id":"call-9","name":"apply_patch","input":"*** Begin Patch"}}),
        json!({"type":"response_item","timestamp":"2026-11-22T10:05:04Z","payload":{"type":"custom_tool_call_output","call_id":"call-9","output":"{\"output\":\"Success\",\"metadata\":{\"exit_code\":0}}"}}),
    ];
    std::fs::write(
        &codex_file,
        codex_lines.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n"),
    )
    .unwrap();
    let (codex_msgs, _) = history::read_codex(&codex_file, None).unwrap();
    assert_eq!(codex_msgs.len(), 3);
    assert_eq!(codex_msgs[0].text, "fix bug");
    assert_eq!(codex_msgs[1].thinking, "checking code");
    assert_eq!(codex_msgs[2].tool_name, "apply_patch");
    assert_eq!(codex_msgs[2].text, "Success");
    assert!(!codex_msgs[2].is_error);
    assert!(codex_msgs[2].diff.is_some());
    assert!(codex_msgs[2].created_at > 0);
}

#[test]
fn acp_preserves_mode_rposition_diff_and_remote_redaction() {
    let dir = TempDir::new().expect("tmp");
    let host = test_host(&dir);
    let ws_dir = dir.path().join("repo");
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws = host.workspace(&ws_dir.to_string_lossy()).unwrap();
    let sid = host.create(&ws.id, "acp:codex", "acp").unwrap();
    let (runtime, _rx) = attach_runtime(&host, &sid, Wire::Acp);

    host.update(&sid, Some(&runtime.instance), |v| {
        v.config_options = vec![json!({"id":"$mode","name":"权限模式","category":"mode","type":"select","currentValue":"ask"})];
    });
    // config_option_update without mode must keep $mode intact
    host.handle_acp_frame(
        &sid,
        &runtime,
        json!({"method":"session/update","params":{"update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"thought_level","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low"},{"value":"high"}]}]}}}),
    );
    // Repeated toolCallId across turns uses latest instance (.rposition) and keeps rawInput & diff
    host.handle_acp_frame(
        &sid,
        &runtime,
        json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"id1","title":"Old","kind":"edit","rawInput":{"path":"a.ts"}}}}),
    );
    host.handle_acp_frame(
        &sid,
        &runtime,
        json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"id1","status":"completed","rawInput":{},"locations":[{"path":"a.ts","line":10}],"content":[{"diff":{"oldText":"a","newText":"b"}}]}}}),
    );

    let view = host.view(&sid).unwrap();
    assert!(view.config_options.iter().any(|o| o["id"] == "$mode"));
    assert_eq!(view.thinking_level, "high");
    let tool = view.messages.last().unwrap();
    assert_eq!(tool.tool_kind, "edit");
    assert_eq!(tool.arguments, json!({"path": "a.ts"}));
    assert_eq!(tool.locations.len(), 1);
    assert_eq!(tool.diff, Some(json!({"oldText":"a","newText":"b"})));

    let remote_snap = host.snapshot_for(false);
    for h in remote_snap["harnesses"].as_array().unwrap() {
        assert!(h.get("command").is_none());
        assert!(h.get("args").is_none());
    }
    assert_eq!(host.host_tools_policy("acp:codex").write, "allow");
    assert_eq!(host.host_tools_policy("acp:codex").permission, "ask");
    assert!(!host.host_tools_policy("acp:codex").allow_outside_workspace);
}

#[test]
fn custom_codex_command_is_not_overridden_and_defaults_have_capabilities() {
    let defaults = registry::defaults();
    let pi = defaults.iter().find(|d| d.id == "pi").unwrap();
    assert!(pi.capabilities.supports_fork);
    assert!(pi.capabilities.supports_compaction);

    let custom_codex = HarnessDescriptor {
        id: "acp:codex".into(),
        display_name: "Custom Codex".into(),
        kind: "acp".into(),
        command: "nonexistent-custom-codex-bin".into(),
        args: vec!["--acp".into()],
        installed: false,
        capabilities: Capabilities::default(),
    };
    let res = registry::launch(&custom_codex);
    assert!(res.is_err(), "custom acp:codex command must not silently fall back to managed_codex()");
}

#[tokio::test]
async fn phase3_and_4_queue_policy_diagnose_and_delete_work() {
    let dir = TempDir::new().expect("tmp");
    let host = test_host(&dir);
    let ws_dir = dir.path().join("repo");
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws = host.workspace(&ws_dir.to_string_lossy()).unwrap();
    let sid = host.create(&ws.id, "pi", "demo").unwrap();
    let (_runtime, _rx) = attach_runtime(&host, &sid, Wire::Pi);

    host.update(&sid, None, |v| {
        v.state = "working".into();
        v.capabilities.supports_queue = true;
    });
    let desktop = Principal { id: "desktop".into(), desktop: true };

    // Enqueue 2 items and manipulate via queue commands
    host.accept_prompt(&sid, json!({ "text": "first", "queue": true })).unwrap();
    host.accept_prompt(&sid, json!({ "text": "second", "queue": true })).unwrap();
    assert_eq!(host.view(&sid).unwrap().queue.len(), 2);

    host.dispatch(
        &desktop,
        Command {
            request_id: "q-upd".into(),
            operation: "session.queue.update".into(),
            session_id: Some(sid.clone()),
            instance_id: None,
            payload: json!({ "index": 1, "text": "second-edited" }),
        },
    )
    .await
    .unwrap();
    host.dispatch(
        &desktop,
        Command {
            request_id: "q-move".into(),
            operation: "session.queue.move".into(),
            session_id: Some(sid.clone()),
            instance_id: None,
            payload: json!({ "from": 1, "to": 0 }),
        },
    )
    .await
    .unwrap();
    let view = host.view(&sid).unwrap();
    assert_eq!(view.queue[0]["text"], json!("second-edited"));

    host.dispatch(
        &desktop,
        Command {
            request_id: "q-del".into(),
            operation: "session.queue.remove".into(),
            session_id: Some(sid.clone()),
            instance_id: None,
            payload: json!({ "index": 0 }),
        },
    )
    .await
    .unwrap();
    assert_eq!(host.view(&sid).unwrap().queue.len(), 1);

    // Host tools policy set & get
    host.dispatch(
        &desktop,
        Command {
            request_id: "pol-set".into(),
            operation: "host.policy.set".into(),
            session_id: None,
            instance_id: None,
            payload: json!({ "harnessId": "acp:codex", "read": "allow", "write": "deny" }),
        },
    )
    .await
    .unwrap();
    assert_eq!(host.host_tools_policy("acp:codex").write, "deny");

    host.dispatch(
        &desktop,
        Command {
            request_id: "pol-set-2".into(),
            operation: "host.policy.set".into(),
            session_id: None,
            instance_id: None,
            payload: json!({
                "harnessId": "acp:antigravity",
                "permission": "allow_all",
                "allowOutsideWorkspace": true
            }),
        },
    )
    .await
    .unwrap();
    let agy_pol = host.host_tools_policy("acp:antigravity");
    assert_eq!(agy_pol.permission, "allow_all");
    assert!(agy_pol.allow_outside_workspace);
    assert_eq!(agy_pol.write, "allow");

    // Diagnose returns structured verdict entries for built-ins
    let diag = host
        .dispatch(
            &desktop,
            Command {
                request_id: "diag-1".into(),
                operation: "harness.diagnose".into(),
                session_id: None,
                instance_id: None,
                payload: json!({}),
            },
        )
        .await
        .unwrap();
    let items = diag["items"].as_array().unwrap();
    assert!(items.iter().any(|item| item["id"] == "pi"));
    assert!(items.iter().any(|item| item["id"] == "acp:codex"));

    // Custom harness save & delete
    host.dispatch(
        &desktop,
        Command {
            request_id: "h-save".into(),
            operation: "harness.save".into(),
            session_id: None,
            instance_id: None,
            payload: json!({
                "id": "acp:custom-test1",
                "displayName": "TestACP",
                "kind": "acp",
                "command": "echo",
                "args": []
            }),
        },
    )
    .await
    .unwrap();
    assert!(host.harnesses().iter().any(|h| h.id == "acp:custom-test1"));
    host.dispatch(
        &desktop,
        Command {
            request_id: "h-del".into(),
            operation: "harness.delete".into(),
            session_id: None,
            instance_id: None,
            payload: json!({ "id": "acp:custom-test1" }),
        },
    )
    .await
    .unwrap();
    assert!(!host.harnesses().iter().any(|h| h.id == "acp:custom-test1"));
}

#[tokio::test]
async fn deferred_busy_config_applies_before_next_turn_and_history_replay_omits_fake_clock() {
    let dir = TempDir::new().expect("tmp");
    let host = test_host(&dir);
    let ws_dir = dir.path().join("repo");
    std::fs::create_dir_all(&ws_dir).unwrap();
    let ws = host.workspace(&ws_dir.to_string_lossy()).unwrap();
    let sid = host.create(&ws.id, "acp:antigravity", "agy").unwrap();
    let (runtime, rx) = attach_runtime(&host, &sid, Wire::Acp);

    // 1. Replaying history sets created_at = 0 when explicit timestamp is absent.
    runtime.loading_history.store(true, std::sync::atomic::Ordering::Release);
    host.handle_acp_frame(
        &sid,
        &runtime,
        json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hist"}}}}),
    );
    assert_eq!(host.view(&sid).unwrap().messages.last().unwrap().created_at, 0);
    runtime.loading_history.store(false, std::sync::atomic::Ordering::Release);

    // 2. While busy, config changes defer cleanly, update view immediately, and flush in model->thinking->config order.
    host.update(&sid, Some(&runtime.instance), |v| {
        v.state = "working".into();
        v.models = vec![
            json!({"id":"m1","provider":"acp:antigravity","name":"M1"}),
            json!({"id":"m2","provider":"acp:antigravity","name":"M2"}),
        ];
        v.config_options = vec![
            json!({"id":"model","name":"Model","category":"model","type":"select","currentValue":"m1","options":[{"value":"m1"},{"value":"m2"}]}),
            json!({"id":"thought_level","name":"Thinking","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}),
            json!({"id":"$mode","name":"Mode","category":"mode","type":"select","currentValue":"default","options":[{"value":"default"},{"value":"auto"}]}),
        ];
    });
    let desktop = Principal { id: "desktop".into(), desktop: true };
    let r1 = host.dispatch(&desktop, Command {
        request_id: "cfg-mode".into(),
        operation: "session.config".into(),
        session_id: Some(sid.clone()),
        instance_id: None,
        payload: json!({"configId":"$mode","value":"auto"}),
    }).await.unwrap();
    assert_eq!(r1["deferred"], json!(true));
    let r2 = host.dispatch(&desktop, Command {
        request_id: "cfg-think".into(),
        operation: "session.thinking".into(),
        session_id: Some(sid.clone()),
        instance_id: None,
        payload: json!({"level":"high"}),
    }).await.unwrap();
    assert_eq!(r2["deferred"], json!(true));
    let r3 = host.dispatch(&desktop, Command {
        request_id: "cfg-model".into(),
        operation: "session.model".into(),
        session_id: Some(sid.clone()),
        instance_id: None,
        payload: json!({"provider":"acp:antigravity","modelId":"m2"}),
    }).await.unwrap();
    assert_eq!(r3["deferred"], json!(true));

    // View updated optimistically and nothing sent over wire mid-turn
    let busy_view = host.view(&sid).unwrap();
    assert_eq!(busy_view.model.as_ref().unwrap()["id"], json!("m2"));
    assert_eq!(busy_view.thinking_level, "high");
    assert_eq!(busy_view.config_options[2]["currentValue"], json!("auto"));
    assert!(rx.try_recv().is_err());

    // Simulate responder for the 3 RPC requests when pending config flushes
    let responder_bridge = runtime.bridge.clone();
    let applied_order = Arc::new(Mutex::new(Vec::<String>::new()));
    let order_ref = applied_order.clone();
    std::thread::spawn(move || {
        for _ in 0..3 {
            let Ok(req) = rx.recv() else { break };
            let req_id = req["id"].as_str().unwrap().to_string();
            let method = req["method"].as_str().unwrap().to_string();
            let key = if method == "session/set_mode" {
                req["params"]["modeId"].as_str().unwrap().to_string()
            } else {
                format!("{}:{}", req["params"]["configId"].as_str().unwrap(), req["params"]["value"].as_str().unwrap())
            };
            lock(&order_ref).push(key.clone());
            responder_bridge.resolve_test(&req_id, Ok(json!({"applied": key})));
        }
    });

    host.update(&sid, Some(&runtime.instance), |v| v.state = "idle".into());
    host.apply_pending_config(&sid, &runtime).await.unwrap();
    assert!(lock(&runtime.pending_config).is_empty());
    assert_eq!(
        *lock(&applied_order),
        vec!["model:m2", "thought_level:high", "auto"]
    );

    // 3. Reopening Host from SQLite preserves per-session and per-harness preferences.
    drop(runtime);
    drop(host);
    let reopened = test_host(&dir);
    let persisted = reopened.view(&sid).unwrap().binding.preferences;
    assert_eq!(persisted.model_id.as_deref(), Some("m2"));
    assert_eq!(persisted.thinking_level.as_deref(), Some("high"));
    assert_eq!(persisted.configs.get("$mode").map(String::as_str), Some("auto"));
    let h_prefs = reopened.harness_preferences("acp:antigravity");
    assert_eq!(h_prefs.model_id.as_deref(), Some("m2"));
    assert_eq!(h_prefs.thinking_level.as_deref(), Some("high"));
    assert_eq!(h_prefs.configs.get("$mode").map(String::as_str), Some("auto"));
}

#[test]
fn codex_default_session_exposes_thinking_levels_when_config_omits_thought_level() {
    let dir = TempDir::new().unwrap();
    let host = test_host(&dir);
    let ws = host.workspace(&dir.path().to_string_lossy()).unwrap();
    let sid = host.create(&ws.id, "acp:codex", "Codex Thinking Test").unwrap();

    host.update(&sid, None, |v| {
        super::acp::apply_session_for_test(
            v,
            &json!({
                "sessionId": "native-codex-1",
                "models": {
                    "currentModelId": "custom-relay-model/high",
                    "availableModels": [
                        { "modelId": "gpt-5.3-codex/low", "name": "5.3 Codex (low)" },
                        { "modelId": "gpt-5.3-codex/medium", "name": "5.3 Codex (medium)" },
                        { "modelId": "gpt-5.3-codex/high", "name": "5.3 Codex (high)" },
                        { "modelId": "gpt-5.3-codex/xhigh", "name": "5.3 Codex (xhigh)" }
                    ]
                },
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "custom-relay-model",
                        "options": [{ "value": "gpt-5.3-codex", "name": "5.3 Codex" }]
                    }
                ]
            }),
        );
    });

    let view = host.view(&sid).unwrap();
    assert!(view.capabilities.supports_thinking);
    assert_eq!(
        view.thinking_levels,
        vec!["low", "medium", "high", "xhigh"]
    );
    assert_eq!(view.thinking_level, "high");
    let setting = super::coordinator::Host::acp_setting_kind_for_test(
        &view,
        "session.thinking",
        &json!({ "level": "xhigh" }),
    )
    .unwrap();
    assert_eq!(setting, ("__codex_thinking__".into(), "xhigh".into()));
}

