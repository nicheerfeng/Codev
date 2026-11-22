use crate::modules::proc::hide_console;
#[cfg(windows)]
use crate::modules::proc::job::ProcessJob;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const EVENT: &str = "codev://antigravity-agent-event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    connection_id: u64,
    message: Value,
}

struct PendingRequest {
    method: String,
    session_id: Option<String>,
    sender: mpsc::Sender<Value>,
    notify_frontend: bool,
}

struct Connection {
    id: u64,
    app: AppHandle,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, PendingRequest>>,
    pending_permissions: Mutex<HashMap<String, String>>,
    sessions: Mutex<HashSet<String>>,
    next_request: AtomicU64,
}

struct AgentProcess {
    child: Child,
    connection: Arc<Connection>,
    load_session: bool,
    close_session: bool,
    image_input: bool,
    #[cfg(windows)]
    _job: ProcessJob,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct AntigravityAgentState {
    process: Mutex<Option<AgentProcess>>,
    next_connection: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    connection_id: u64,
    session_id: String,
    load_session: bool,
    image_input: bool,
    config_options: Value,
}

fn find_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let path = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
            if path.is_file() {
                return Some(path);
            }
        }
        for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
            for name in ["agy.exe", "agy.cmd"] {
                let path = directory.join(name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|directory| directory.join("agy"))
            .find(|path| path.is_file())
    }
}

fn antigravity_command() -> Result<Command, String> {
    let path = find_binary().ok_or_else(|| {
        "找不到 Antigravity CLI。请安装 CLI，并确认 agy.exe 位于 PATH 或 %LOCALAPPDATA%\\agy\\bin。".to_string()
    })?;
    #[cfg(windows)]
    let mut command = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
    {
        let mut command = Command::new("cmd.exe");
        let command_line = format!("\"{}\" acp --stdio", path.display());
        command.args(["/D", "/S", "/C", &format!("\"{command_line}\"")]);
        command
    } else {
        let mut command = Command::new(path);
        command.args(["acp", "--stdio"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(path);
        command.args(["acp", "--stdio"]);
        command
    };
    hide_console(&mut command);
    Ok(command)
}

fn emit(connection: &Connection, message: Value) {
    let _ = connection.app.emit(
        EVENT,
        EventPayload {
            connection_id: connection.id,
            message,
        },
    );
}

fn start_readers(
    connection: Arc<Connection>,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
) {
    let output = Arc::clone(&connection);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                emit(
                    &output,
                    json!({"method":"bridge/error","params":{"message":"Antigravity CLI 返回了无效 ACP 数据。"}}),
                );
                continue;
            };
            if message.get("method").is_some() {
                if message.get("method").and_then(Value::as_str)
                    == Some("session/request_permission")
                {
                    if let (Some(id), Some(session_id), Ok(mut permissions)) = (
                        message.get("id"),
                        message["params"]["sessionId"].as_str(),
                        output.pending_permissions.lock(),
                    ) {
                        permissions.insert(id.to_string(), session_id.to_string());
                    }
                }
                emit(&output, message);
                continue;
            }
            if let Some(id) = message.get("id") {
                let key = id.to_string();
                let pending = output
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut requests| requests.remove(&key));
                if let Some(request) = pending {
                    if request.notify_frontend {
                        emit(
                            &output,
                            json!({
                                "method":"bridge/response",
                                "params":{
                                    "requestMethod":request.method,
                                    "sessionId":request.session_id,
                                    "result":message.get("result"),
                                    "error":message.get("error")
                                }
                            }),
                        );
                    }
                    let _ = request.sender.send(message);
                }
            }
        }
        emit(&output, json!({"method":"bridge/closed"}));
    });

    let diagnostics = connection;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let message = line.trim();
            if !message.is_empty() {
                emit(
                    &diagnostics,
                    json!({"method":"bridge/stderr","params":{"message":message}}),
                );
            }
        }
    });
}

fn request(
    connection: &Connection,
    method: &str,
    params: Value,
    notify_frontend: bool,
) -> Result<mpsc::Receiver<Value>, String> {
    let id = connection.next_request.fetch_add(1, Ordering::Relaxed) + 1;
    let key = id.to_string();
    let (sender, receiver) = mpsc::channel();
    connection
        .pending
        .lock()
        .map_err(|_| "Antigravity 请求锁不可用")?
        .insert(
            key.clone(),
            PendingRequest {
                method: method.to_string(),
                session_id: params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                sender,
                notify_frontend,
            },
        );
    let message = serde_json::to_vec(&json!({
        "jsonrpc":"2.0",
        "id":id,
        "method":method,
        "params":params
    }))
    .map_err(|error| error.to_string())?;
    let write_result = (|| {
        let mut stdin = connection
            .stdin
            .lock()
            .map_err(|_| "Antigravity 输入流锁不可用")?;
        stdin
            .write_all(&[message.as_slice(), b"\n"].concat())
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("写入 Antigravity 请求失败：{error}"))
    })();
    if let Err(error) = write_result {
        if let Ok(mut pending) = connection.pending.lock() {
            pending.remove(&key);
        }
        return Err(error);
    }
    Ok(receiver)
}

fn wait_response(receiver: mpsc::Receiver<Value>, operation: &str) -> Result<Value, String> {
    let message = receiver
        .recv_timeout(Duration::from_secs(90))
        .map_err(|_| format!("等待 Antigravity {operation} 超时。"))?;
    if let Some(error) = message.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Antigravity 请求失败。")
            .to_string());
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| format!("Antigravity {operation} 响应无效。"))
}

fn notification(connection: &Connection, method: &str, params: Value) -> Result<(), String> {
    let message = serde_json::to_vec(&json!({
        "jsonrpc":"2.0",
        "method":method,
        "params":params
    }))
    .map_err(|error| error.to_string())?;
    let mut stdin = connection
        .stdin
        .lock()
        .map_err(|_| "Antigravity 输入流锁不可用")?;
    stdin
        .write_all(&[message.as_slice(), b"\n"].concat())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入 Antigravity 请求失败：{error}"))
}

fn create_process(app: AppHandle, id: u64) -> Result<AgentProcess, String> {
    let mut child = antigravity_command()?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 Antigravity CLI 失败：{error}"))?;
    #[cfg(windows)]
    let job = match ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let stdin = child.stdin.take().ok_or("Antigravity stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("Antigravity stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Antigravity stderr 不可用")?;
    let connection = Arc::new(Connection {
        id,
        app,
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        pending_permissions: Mutex::new(HashMap::new()),
        sessions: Mutex::new(HashSet::new()),
        next_request: AtomicU64::new(0),
    });
    let mut process = AgentProcess {
        child,
        connection,
        load_session: false,
        close_session: false,
        image_input: false,
        #[cfg(windows)]
        _job: job,
    };
    start_readers(Arc::clone(&process.connection), stdout, stderr);
    let handshake = request(
        &process.connection,
        "initialize",
        json!({
            "protocolVersion":1,
            "clientCapabilities":{},
            "clientInfo":{"name":"Codev","title":"Codev","version":env!("CARGO_PKG_VERSION")}
        }),
        false,
    )?;
    let capabilities = wait_response(handshake, "初始化")?;
    if capabilities.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Antigravity CLI 使用了当前插件不支持的 ACP 协议版本。".into());
    }
    process.load_session = capabilities["agentCapabilities"]["loadSession"] == true;
    process.close_session =
        capabilities["agentCapabilities"]["sessionCapabilities"]["close"].is_object();
    process.image_input = capabilities["agentCapabilities"]["promptCapabilities"]["image"] == true;
    Ok(process)
}

#[tauri::command]
pub fn antigravity_agent_start(
    app: AppHandle,
    state: State<'_, AntigravityAgentState>,
    cwd: String,
    session_id: Option<String>,
) -> Result<StartResult, String> {
    let cwd = std::fs::canonicalize(&cwd).map_err(|error| error.to_string())?;
    if !cwd.is_dir() {
        return Err("Antigravity 工作目录不可用。".into());
    }
    let mut slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process_exited = match slot.as_mut() {
        Some(process) => process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some(),
        None => false,
    };
    if process_exited {
        *slot = None;
    }
    if slot.is_none() {
        let id = state.next_connection.fetch_add(1, Ordering::Relaxed) + 1;
        *slot = Some(create_process(app, id)?);
    }
    let process = slot.as_ref().ok_or("Antigravity 连接不可用")?;
    let method = if session_id.is_some() {
        if !process.load_session {
            return Err("此 Antigravity CLI 暂不支持恢复已有会话。".into());
        }
        "session/load"
    } else {
        "session/new"
    };
    let mut params = json!({"cwd":cwd,"mcpServers":[]});
    if let Some(session_id) = &session_id {
        params["sessionId"] = json!(session_id);
    }
    let receiver = request(&process.connection, method, params, false)?;
    let result = wait_response(receiver, "创建会话")?;
    let session_id = session_id
        .or_else(|| {
            result
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or("Antigravity 未返回会话编号")?;
    process
        .connection
        .sessions
        .lock()
        .map_err(|_| "Antigravity 会话锁不可用")?
        .insert(session_id.clone());
    Ok(StartResult {
        connection_id: process.connection.id,
        session_id,
        load_session: process.load_session,
        image_input: process.image_input,
        config_options: result
            .get("configOptions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

#[tauri::command]
pub fn antigravity_agent_send(
    state: State<'_, AntigravityAgentState>,
    connection_id: u64,
    session_id: String,
    text: String,
    images: Option<Vec<Value>>,
) -> Result<(), String> {
    let slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process = slot
        .as_ref()
        .filter(|process| process.connection.id == connection_id)
        .ok_or("Antigravity 连接已关闭")?;
    if !process
        .connection
        .sessions
        .lock()
        .map_err(|_| "Antigravity 会话锁不可用")?
        .contains(&session_id)
    {
        return Err("Antigravity 会话未加载。".into());
    }
    let mut prompt = Vec::new();
    if !text.trim().is_empty() {
        prompt.push(json!({"type":"text","text":text}));
    }
    for image in images.unwrap_or_default() {
        let data = image.get("data").and_then(Value::as_str).unwrap_or("");
        let mime = image
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        if data.is_empty() {
            continue;
        }
        prompt.push(json!({"type":"image","data":data,"mimeType":mime}));
    }
    if prompt.is_empty() {
        return Err("消息内容为空。".into());
    }
    request(
        &process.connection,
        "session/prompt",
        json!({"sessionId":session_id,"prompt":prompt}),
        true,
    )?;
    Ok(())
}

#[tauri::command]
pub fn antigravity_agent_cancel(
    state: State<'_, AntigravityAgentState>,
    connection_id: u64,
    session_id: String,
) -> Result<(), String> {
    let slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process = slot
        .as_ref()
        .filter(|process| process.connection.id == connection_id)
        .ok_or("Antigravity 连接已关闭")?;
    let permission_ids = process
        .connection
        .pending_permissions
        .lock()
        .map_err(|_| "Antigravity 权限锁不可用")?
        .iter()
        .filter_map(|(id, owner)| (owner == &session_id).then_some(id.clone()))
        .collect::<Vec<_>>();
    for id in permission_ids {
        let request_id: Value = serde_json::from_str(&id).unwrap_or(Value::String(id.clone()));
        let response = serde_json::to_vec(&json!({
            "jsonrpc":"2.0",
            "id":request_id,
            "result":{"outcome":{"outcome":"cancelled"}}
        }))
        .map_err(|error| error.to_string())?;
        let mut stdin = process
            .connection
            .stdin
            .lock()
            .map_err(|_| "Antigravity 输入流锁不可用")?;
        stdin
            .write_all(&[response.as_slice(), b"\n"].concat())
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("取消 Antigravity 权限请求失败：{error}"))?;
        if let Ok(mut pending) = process.connection.pending_permissions.lock() {
            pending.remove(&id);
        }
    }
    notification(
        &process.connection,
        "session/cancel",
        json!({"sessionId":session_id}),
    )
}

#[tauri::command]
pub fn antigravity_agent_permission(
    state: State<'_, AntigravityAgentState>,
    connection_id: u64,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    let slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process = slot
        .as_ref()
        .filter(|process| process.connection.id == connection_id)
        .ok_or("Antigravity 连接已关闭")?;
    let outcome = match option_id {
        Some(option_id) => json!({"outcome":"selected","optionId":option_id}),
        None => json!({"outcome":"cancelled"}),
    };
    let message = serde_json::to_vec(&json!({
        "jsonrpc":"2.0",
        "id":request_id,
        "result":{"outcome":outcome}
    }))
    .map_err(|error| error.to_string())?;
    let mut stdin = process
        .connection
        .stdin
        .lock()
        .map_err(|_| "Antigravity 输入流锁不可用")?;
    stdin
        .write_all(&[message.as_slice(), b"\n"].concat())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("回复 Antigravity 权限请求失败：{error}"))?;
    if let Ok(mut pending) = process.connection.pending_permissions.lock() {
        pending.remove(&request_id.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn antigravity_agent_set_config_option(
    state: State<'_, AntigravityAgentState>,
    connection_id: u64,
    session_id: String,
    config_id: String,
    value: Value,
) -> Result<Value, String> {
    let slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process = slot
        .as_ref()
        .filter(|process| process.connection.id == connection_id)
        .ok_or("Antigravity 连接已关闭")?;
    let receiver = request(
        &process.connection,
        "session/set_config_option",
        json!({"sessionId":session_id,"configId":config_id,"value":value}),
        false,
    )?;
    let result = wait_response(receiver, "切换配置")?;
    Ok(result
        .get("configOptions")
        .cloned()
        .unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub fn antigravity_agent_close_session(
    state: State<'_, AntigravityAgentState>,
    connection_id: u64,
    session_id: String,
) -> Result<(), String> {
    let mut slot = state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")?;
    let process = slot
        .as_ref()
        .filter(|process| process.connection.id == connection_id)
        .ok_or("Antigravity 连接已关闭")?;
    if process.close_session {
        let receiver = request(
            &process.connection,
            "session/close",
            json!({"sessionId":session_id}),
            false,
        )?;
        let _ = wait_response(receiver, "关闭会话")?;
    }
    process
        .connection
        .sessions
        .lock()
        .map_err(|_| "Antigravity 会话锁不可用")?
        .remove(&session_id);
    if process
        .connection
        .sessions
        .lock()
        .map_err(|_| "Antigravity 会话锁不可用")?
        .is_empty()
    {
        *slot = None;
    }
    Ok(())
}

#[tauri::command]
pub fn antigravity_agent_close_all(state: State<'_, AntigravityAgentState>) -> Result<(), String> {
    *state
        .process
        .lock()
        .map_err(|_| "Antigravity 进程锁不可用")? = None;
    Ok(())
}
