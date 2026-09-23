pub mod assets;
mod history;
mod paths;
use history::{
    append_session_entry, clone_session_file, delete_session_file, list_sessions,
    parse_session_history,
};

use crate::modules::proc::hide_console;
#[cfg(windows)]
use crate::modules::proc::job::ProcessJob;
use paths::{
    canonical_display, create_pi_command, pi_home_dir, pi_sessions_dir, probe_binary,
    resolve_pi_binary,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const PI_EVENT: &str = "codev://pi-agent-event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiEventPayload {
    session_id: u64,
    stream: &'static str,
    event: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProbeResult {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStartRequest {
    cwd: String,
    session_path: Option<String>,
    name: Option<String>,
    pi_path: Option<String>,
    model_test: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStartResult {
    session_id: u64,
    process_id: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionSummary {
    path: String,
    id: String,
    cwd: String,
    name: Option<String>,
    preview: Option<String>,
    created_at: String,
    updated_at: u64,
    message_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelsFile {
    path: String,
    exists: bool,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionHistory {
    messages: Vec<Value>,
    model: Option<Value>,
    thinking_level: Option<String>,
    session_name: Option<String>,
    session_file: String,
    oldest_offset: u64,
    has_more: bool,
    context_tokens: Option<u64>,
    context_percent: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionAppendRequest {
    path: String,
    kind: String,
    name: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    thinking_level: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiClonedSession {
    path: String,
    id: String,
    name: Option<String>,
}

const HISTORY_PAGE_SIZE: usize = 150;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiListedModel {
    provider: String,
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
}

/// 表示 pi-subagents 为当前父会话记录的一个只读运行任务。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSubagentRun {
    run_id: String,
    agent: String,
    title: String,
    status: String,
    summary: Option<String>,
    updated_at: String,
    session: Option<PiSessionSummary>,
}

/// 读取 pi-subagents mission 目录，不把子任务伪装成普通 Pi session。
#[tauri::command]
pub fn pi_agent_list_subagent_runs(owner_session_path: String) -> Result<Vec<PiSubagentRun>, String> {
    let Some(home) = pi_home_dir() else { return Ok(Vec::new()); };
    let root = home.join(".pi-subagents").join("missions");
    if !root.is_dir() { return Ok(Vec::new()); }
    let normalize = |value: &str| {
        value
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .trim_start_matches("/?/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    let owner = normalize(&owner_session_path);
    let mut runs = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        let Ok(value) = serde_json::from_str::<Value>(&fs::read_to_string(&path).map_err(|e| e.to_string())?) else { continue; };
        let mission_owner = value.get("ownerSessionId").and_then(Value::as_str).unwrap_or("");
        let mission = normalize(mission_owner);
        if mission != owner { continue; }
        let candidates = history::parse_session_summary(Path::new(&owner_session_path), None)
            .map(|session| list_sessions(&session.cwd, usize::MAX)).unwrap_or_default();
        let title = value.get("title").or_else(|| value.get("objective")).and_then(Value::as_str).unwrap_or("子代理任务").to_string();
        let mission_status = value.get("status").and_then(Value::as_str).unwrap_or("unknown");
        let updated_at = value.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(items) = value.get("runs").and_then(Value::as_array) {
            for item in items {
                let Some(run_id) = item.get("runId").and_then(Value::as_str) else { continue; };
                let status = item.get("status").and_then(Value::as_str).unwrap_or(mission_status).to_string();
                let agent = item.get("agent").and_then(Value::as_str).unwrap_or("subagent").to_string();
                let state = item.get("asyncDir").and_then(Value::as_str)
                    .and_then(|dir| fs::read_to_string(Path::new(dir).join("status.json")).ok())
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok());
                if let Some(steps) = state.as_ref().and_then(|state| state.get("steps")).and_then(Value::as_array) {
                    for (index, step) in steps.iter().enumerate() {
                        let session = step.get("sessionFile").and_then(Value::as_str)
                            .and_then(|path| history::parse_session_summary(Path::new(path), None));
                        runs.push(PiSubagentRun { run_id: format!("{run_id}:{index}"), agent: step.get("agent").and_then(Value::as_str).unwrap_or(&agent).to_string(), title: title.clone(), status: step.get("status").and_then(Value::as_str).unwrap_or(&status).to_string(), summary: None, updated_at: updated_at.clone(), session });
                    }
                } else {
                    let prefix = format!("subagent-{agent}-{run_id}-");
                    for candidate in candidates.iter().filter(|session| session.name.as_deref().is_some_and(|name| name.starts_with(&prefix))) {
                        let session = history::parse_session_summary(Path::new(&candidate.path), None);
                        runs.push(PiSubagentRun { run_id: format!("{run_id}:{}", candidate.id), agent: agent.clone(), title: title.clone(), status: status.clone(), summary: value.get("summary").and_then(Value::as_str).map(str::to_string), updated_at: updated_at.clone(), session });
                    }
                }
            }
        }
    }
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(runs)
}

struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pid: u32,
    #[cfg(windows)]
    _job: Option<ProcessJob>,
}

pub struct PiAgentState {
    watcher: Mutex<Option<(String, notify::RecommendedWatcher)>>,
    next_id: AtomicU64,
    sessions: Arc<Mutex<HashMap<u64, PiProcess>>>,
}

impl Default for PiAgentState {
    /// 创建空的 Pi RPC 进程注册表。
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            next_id: AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// 监听原生会话目录，兼容任何 Pi 客户端新建或更新的会话。
#[tauri::command]
pub fn pi_agent_watch_sessions(
    app: AppHandle,
    state: State<'_, PiAgentState>,
    enabled: bool,
    cwd: String,
) -> Result<(), String> {
    use notify::Watcher;
    let mut slot = state.watcher.lock().map_err(|_| "会话监听锁不可用")?;
    if !enabled {
        if slot.as_ref().is_some_and(|(owner, _)| owner == &cwd) { *slot = None; }
        return Ok(());
    }
    if slot.as_ref().is_some_and(|(owner, _)| owner == &cwd) {
        return Ok(());
    }
    let root = history::project_sessions_dir(&cwd).ok_or("Pi 会话目录不可用")?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                let _ = app.emit("codev://pi-sessions-changed", ());
            }
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, notify::RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    *slot = Some((cwd, watcher));
    Ok(())
}

impl Drop for PiAgentState {
    /// 在应用退出时终止仍由 Codev 管理的 Pi 子进程。
    fn drop(&mut self) {
        close_all_processes(&self.sessions);
    }
}

/// 向前端发送一个带会话归属的 Pi 事件。
fn emit_event(app: &AppHandle, session_id: u64, stream: &'static str, event: Value) {
    let _ = app.emit(
        PI_EVENT,
        PiEventPayload {
            session_id,
            stream,
            event,
        },
    );
}

/// 解析一条严格 LF JSONL 记录，并兼容记录尾部的单个 CR。
fn parse_rpc_line(buffer: &[u8]) -> Result<Option<Value>, String> {
    let mut line = buffer;
    if line.last() == Some(&b'\n') {
        line = &line[..line.len() - 1];
    }
    if line.last() == Some(&b'\r') {
        line = &line[..line.len() - 1];
    }
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(line)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// 按严格 LF 分隔读取 Pi stdout，并解析每一条 JSON 事件。
fn stream_stdout(app: AppHandle, session_id: u64, stdout: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => match parse_rpc_line(&buffer) {
                    Ok(Some(event)) => emit_event(&app, session_id, "stdout", event),
                    Ok(None) => {}
                    Err(error) => emit_event(
                        &app,
                        session_id,
                        "protocol",
                        json!({
                            "type": "protocol_error",
                            "error": error.to_string(),
                            "line": String::from_utf8_lossy(&buffer).trim_end_matches(['\r', '\n']),
                        }),
                    ),
                },
                Err(error) => {
                    emit_event(
                        &app,
                        session_id,
                        "protocol",
                        json!({"type": "read_error", "error": error.to_string()}),
                    );
                    break;
                }
            }
        }
    });
}

/// 按行转发 Pi stderr，供界面展示启动和运行错误。
fn stream_stderr(app: AppHandle, session_id: u64, stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(message) if !message.trim().is_empty() => emit_event(
                    &app,
                    session_id,
                    "stderr",
                    json!({"type": "stderr", "message": message}),
                ),
                Ok(_) => {}
                Err(error) => {
                    emit_event(
                        &app,
                        session_id,
                        "stderr",
                        json!({"type": "stderr_error", "error": error.to_string()}),
                    );
                    break;
                }
            }
        }
    });
}

/// 等待 Pi 子进程退出并从注册表中清理对应会话。
fn watch_exit(
    app: AppHandle,
    session_id: u64,
    child: Arc<Mutex<Child>>,
    sessions: Arc<Mutex<HashMap<u64, PiProcess>>>,
) {
    thread::spawn(move || loop {
        let status = child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .flatten();
        if let Some(status) = status {
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&session_id);
            }
            emit_event(
                &app,
                session_id,
                "lifecycle",
                json!({"type": "process_exit", "code": status.code()}),
            );
            break;
        }
        thread::sleep(Duration::from_millis(120));
    });
}

/// 终止注册表内全部 Pi 子进程。
fn close_all_processes(sessions: &Arc<Mutex<HashMap<u64, PiProcess>>>) -> usize {
    let processes = sessions
        .lock()
        .map(|mut sessions| {
            sessions
                .drain()
                .map(|(_, process)| process)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let count = processes.len();
    for process in processes {
        kill_process_tree(&process);
    }
    count
}

/// Windows 先按进程树结束 cmd/node 后代，再回收直接子进程。
fn kill_process_tree(process: &PiProcess) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &process.pid.to_string(), "/T", "/F"]);
        hide_console(&mut command);
        let _ = command.status();
    }
    if let Ok(mut child) = process.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 返回 Pi 是否可用、实际路径和版本。
#[tauri::command]
pub fn pi_agent_probe(custom_path: Option<String>) -> PiProbeResult {
    match resolve_pi_binary(custom_path.as_deref()) {
        Ok(path) => match probe_binary(&path) {
            Ok(version) => PiProbeResult {
                available: true,
                path: Some(canonical_display(&path)),
                version: Some(version),
                error: None,
            },
            Err(error) => PiProbeResult {
                available: false,
                path: Some(canonical_display(&path)),
                version: None,
                error: Some(error),
            },
        },
        Err(error) => PiProbeResult {
            available: false,
            path: None,
            version: None,
            error: Some(error),
        },
    }
}

/// 启动一个新建或恢复的 Pi RPC 会话。
#[tauri::command]
pub fn pi_agent_start(
    app: AppHandle,
    state: State<'_, PiAgentState>,
    request: PiStartRequest,
) -> Result<PiStartResult, String> {
    let cwd = PathBuf::from(&request.cwd);
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", request.cwd));
    }
    let path = resolve_pi_binary(request.pi_path.as_deref())?;
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if request.model_test == Some(true) {
        args.extend(
            [
                "--no-session",
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
            ]
            .map(str::to_string),
        );
    }
    if let Some(session_path) = request
        .session_path
        .filter(|value| !value.trim().is_empty())
    {
        args.push("--session".to_string());
        args.push(session_path);
    }
    if let Some(name) = request.name.filter(|value| !value.trim().is_empty()) {
        args.push("--name".to_string());
        args.push(name);
    }

    let mut command = create_pi_command(&path, &args);
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let process_id = child.id();
    let stdin = child.stdin.take().ok_or("无法连接 Pi stdin")?;
    let stdout = child.stdout.take().ok_or("无法连接 Pi stdout")?;
    let stderr = child.stderr.take().ok_or("无法连接 Pi stderr")?;

    #[cfg(windows)]
    let job = match ProcessJob::create_for(process_id) {
        Ok(job) => Some(job),
        Err(error) => {
            log::warn!("pi agent job-object setup failed for pid={process_id}: {error}");
            None
        }
    };

    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(stdin));
    state
        .sessions
        .lock()
        .map_err(|_| "Pi 进程注册表不可用".to_string())?
        .insert(
            session_id,
            PiProcess {
                child: child.clone(),
                stdin,
                pid: process_id,
                #[cfg(windows)]
                _job: job,
            },
        );

    stream_stdout(app.clone(), session_id, stdout);
    stream_stderr(app.clone(), session_id, stderr);
    watch_exit(app, session_id, child, state.sessions.clone());

    Ok(PiStartResult {
        session_id,
        process_id,
    })
}

/// 向指定 Pi RPC 会话写入一条 JSON 命令。
#[tauri::command]
pub fn pi_agent_send(
    state: State<'_, PiAgentState>,
    session_id: u64,
    command: Value,
) -> Result<(), String> {
    if !command.is_object() || command.get("type").and_then(Value::as_str).is_none() {
        return Err("Pi RPC 命令必须是包含 type 的 JSON 对象".to_string());
    }
    let stdin = state
        .sessions
        .lock()
        .map_err(|_| "Pi 进程注册表不可用".to_string())?
        .get(&session_id)
        .map(|process| process.stdin.clone())
        .ok_or_else(|| "Pi 会话已经结束".to_string())?;
    let mut bytes = serde_json::to_vec(&command).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut stdin = stdin.lock().map_err(|_| "Pi stdin 不可用".to_string())?;
    stdin.write_all(&bytes).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

/// 结束一个 Pi RPC 会话及其子进程树。
#[tauri::command]
pub fn pi_agent_close(state: State<'_, PiAgentState>, session_id: u64) -> Result<bool, String> {
    let process = state
        .sessions
        .lock()
        .map_err(|_| "Pi 进程注册表不可用".to_string())?
        .remove(&session_id);
    let Some(process) = process else {
        return Ok(false);
    };
    kill_process_tree(&process);
    Ok(true)
}

/// 结束 Codev 当前管理的全部 Pi RPC 会话。
#[tauri::command]
pub fn pi_agent_close_all(state: State<'_, PiAgentState>) -> usize {
    close_all_processes(&state.sessions)
}

/// 给临时聊天提供稳定的工作目录。
#[tauri::command]
pub fn pi_agent_home_dir() -> Option<String> {
    pi_home_dir().map(|path| canonical_display(&path))
}

/// 安装程序写入的戳，覆盖安装后可再次显示起始页。
#[tauri::command]
pub fn codev_install_stamp() -> Option<String> {
    dirs::data_local_dir()
        .map(|path| path.join("Codev").join("install-stamp"))
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn list_models_from_file() -> Result<Vec<PiListedModel>, String> {
    let file = pi_agent_read_models()?;
    let value: Value =
        serde_json::from_str(&file.content).unwrap_or_else(|_| json!({ "providers": {} }));
    let Some(providers) = value.get("providers").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut models = Vec::new();
    for (provider, config) in providers {
        let Some(list) = config.get("models").and_then(Value::as_array) else {
            continue;
        };
        for model in list {
            let Some(id) = model.get("id").and_then(Value::as_str) else {
                continue;
            };
            models.push(PiListedModel {
                provider: provider.clone(),
                id: id.to_string(),
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                context_window: model.get("contextWindow").and_then(Value::as_u64),
            });
        }
    }
    Ok(models)
}

/// 异步列出当前工作目录对应的 Pi 原生线程。
#[tauri::command]
pub async fn pi_agent_list_sessions(
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<PiSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions(&cwd, limit.unwrap_or(100)))
        .await
        .map_err(|error| error.to_string())
}

/// 删除会话目录内明确选中的 JSONL 文件，禁止递归或删除目录。
#[tauri::command]
pub fn pi_agent_delete_session(path: String) -> Result<(), String> {
    let root = pi_sessions_dir()
        .ok_or("无法定位 Pi 会话目录")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    delete_session_file(&root, Path::new(&path))
}

/// 浏览历史时只读 JSONL，不启动 Pi runtime。默认从末尾取最近 150 条。
#[tauri::command]
pub fn pi_agent_read_session(
    path: String,
    before: Option<u64>,
    limit: Option<usize>,
) -> Result<PiSessionHistory, String> {
    parse_session_history(Path::new(&path), before, limit.unwrap_or(HISTORY_PAGE_SIZE))
}

/// 复制会话 JSONL 为新线程，不启动 Pi runtime。
#[tauri::command]
pub fn pi_agent_clone_session(path: String) -> Result<PiClonedSession, String> {
    clone_session_file(Path::new(&path))
}

/// 向会话文件追加名称、模型或思考等级，不启动 Pi runtime。
#[tauri::command]
pub fn pi_agent_append_session(request: PiSessionAppendRequest) -> Result<(), String> {
    append_session_entry(request)
}

/// 从 models.json 列出可选模型，不启动 Pi runtime。
#[tauri::command]
pub fn pi_agent_list_models() -> Result<Vec<PiListedModel>, String> {
    list_models_from_file()
}

/// 返回 Pi models.json 的原始文本，不在 Codev 内复制模型密钥。
#[tauri::command]
pub fn pi_agent_read_models() -> Result<PiModelsFile, String> {
    let path = pi_sessions_dir()
        .and_then(|sessions| sessions.parent().map(Path::to_path_buf))
        .ok_or_else(|| "无法定位 Pi 配置目录".to_string())?
        .join("models.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(PiModelsFile {
            path: canonical_display(&path),
            exists: true,
            content,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PiModelsFile {
            path: canonical_display(&path),
            exists: false,
            content: "{\n  \"providers\": {}\n}\n".to_string(),
        }),
        Err(error) => Err(error.to_string()),
    }
}

/// 校验并直接保存 Pi models.json，不创建额外备份文件。
#[tauri::command]
pub fn pi_agent_write_models(content: String) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(&content).map_err(|error| format!("JSON 格式错误：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "根节点必须是 JSON 对象".to_string())?;
    if let Some(providers) = object.get("providers") {
        if !providers.is_object() {
            return Err("providers 必须是对象".to_string());
        }
    }
    let path = pi_sessions_dir()
        .and_then(|sessions| sessions.parent().map(Path::to_path_buf))
        .ok_or_else(|| "无法定位 Pi 配置目录".to_string())?
        .join("models.json");
    let parent = path
        .parent()
        .ok_or_else(|| "Pi 配置目录不存在".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    std::fs::write(
        path,
        if content.ends_with('\n') {
            content
        } else {
            format!("{content}\n")
        },
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::assets::{
        asset_summary, collect_package_specs, recommended_npm_package,
        skill_frontmatter_description,
    };
    use super::history::{message_preview, parse_session_summary};
    use super::paths::same_path;
    use super::{
        append_session_entry, clone_session_file, delete_session_file, parse_rpc_line,
        parse_session_history, PiSessionAppendRequest,
    };
    use serde_json::json;
    use std::io::Write;

    /// 删除仅命中已验证的会话文件，目录、非会话和范围外文件均保留。
    #[test]
    fn deletes_only_valid_session_in_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let content = "{\"type\":\"session\",\"id\":\"s\",\"cwd\":\"C:/work\"}\n";
        let valid = root.join("valid.jsonl");
        let invalid = root.join("invalid.jsonl");
        let outside = directory.path().join("outside.jsonl");
        std::fs::write(&valid, content).unwrap();
        std::fs::write(&invalid, "{}").unwrap();
        std::fs::write(&outside, content).unwrap();
        let canonical = root.canonicalize().unwrap();
        assert!(delete_session_file(&canonical, &outside).is_err());
        assert!(delete_session_file(&canonical, &invalid).is_err());
        assert!(delete_session_file(&canonical, &root).is_err());
        delete_session_file(&canonical, &valid).unwrap();
        assert!(!valid.exists());
        assert!(outside.exists() && invalid.exists());
    }

    #[test]
    /// 验证 Windows 路径比较忽略大小写和尾部分隔符。
    fn compares_windows_paths_without_separator_or_case_noise() {
        assert!(same_path("C:\\Work\\Demo\\", "c:/work/demo"));
        assert!(!same_path("C:/work/demo", "C:/work/other"));
    }

    #[test]
    /// 验证用户消息预览兼容字符串和结构化内容。
    fn extracts_plain_and_structured_user_text() {
        assert_eq!(
            message_preview(&json!({"role":"user","content":" hello  pi "})).as_deref(),
            Some("hello pi")
        );
        assert_eq!(
            message_preview(&json!({"role":"user","content":[{"type":"text","text":"hello"}]}))
                .as_deref(),
            Some("hello")
        );
        assert_eq!(
            message_preview(&json!({"role":"assistant","content":"no"})),
            None
        );
    }

    #[test]
    /// 验证会话摘要只返回目标工作目录的数据。
    fn parses_only_sessions_for_the_requested_workdir() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create session");
        writeln!(file, "{}", json!({"type":"session","id":"s1","timestamp":"2026-09-09T00:00:00Z","cwd":"C:\\Work\\Demo"})).unwrap();
        writeln!(file, "{}", json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"Implement this feature"}]}})).unwrap();
        writeln!(file, "{}", json!({"type":"session_info","name":"Feature"})).unwrap();
        let summary = parse_session_summary(&path, Some("c:/work/demo")).expect("summary");
        assert_eq!(summary.id, "s1");
        assert_eq!(summary.name.as_deref(), Some("Feature"));
        assert_eq!(summary.preview.as_deref(), Some("Implement this feature"));
        assert_eq!(summary.message_count, 1);
        assert!(parse_session_summary(&path, Some("C:/work/other")).is_none());
    }

    #[test]
    /// 只读历史返回用户消息和助手使用过的模型。
    fn reads_session_history_messages_and_last_model() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create session");
        writeln!(
            file,
            "{}",
            json!({"type":"session","id":"s1","cwd":"C:/work"})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_info","id":"n1","parentId":"s1","name":"Demo"})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"thinking_level_change","id":"t1","parentId":"n1","thinkingLevel":"high"})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"model_change","id":"m1","parentId":"t1","provider":"openai","modelId":"gpt-test"})).unwrap();
        for index in 0..25 {
            writeln!(file, "{}", json!({"type":"message","id":format!("u{index}"),"parentId":"m1","message":{"role":"user","content":format!("q{index}")}})).unwrap();
            writeln!(file, "{}", json!({"type":"message","id":format!("a{index}"),"parentId":format!("u{index}"),"message":{"role":"assistant","provider":"openai","model":"gpt-test","content":[{"type":"text","text":format!("a{index}")}]}})).unwrap();
        }
        let previous = std::env::var_os("PI_CODING_AGENT_DIR");
        std::env::set_var("PI_CODING_AGENT_DIR", directory.path());
        let history = parse_session_history(&path, None, 20).expect("history");
        let older = parse_session_history(&path, Some(history.oldest_offset), 20).expect("older");
        let cloned = clone_session_file(&path).expect("clone");
        append_session_entry(PiSessionAppendRequest {
            path: cloned.path.clone(),
            kind: "session_info".into(),
            name: Some("Fork".into()),
            provider: None,
            model_id: None,
            thinking_level: None,
        })
        .unwrap();
        match previous {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        assert_eq!(history.session_name.as_deref(), Some("Demo"));
        assert_eq!(history.thinking_level.as_deref(), Some("high"));
        assert_eq!(history.messages.len(), 20);
        assert!(history.has_more);
        assert_eq!(history.messages[0]["message"]["content"], json!("q15"));
        assert_eq!(
            history.messages[19]["message"]["content"][0]["text"],
            json!("a24")
        );
        assert_eq!(history.model.as_ref().unwrap()["id"], json!("gpt-test"));
        assert_eq!(older.messages.len(), 20);
        assert!(older.has_more);
        assert_eq!(older.messages[0]["message"]["content"], json!("q5"));
        assert_eq!(
            std::fs::read_to_string(&cloned.path)
                .unwrap()
                .contains("\"name\":\"Fork\""),
            true
        );
    }

    #[test]
    /// 离线历史从 assistant.usage.totalTokens 和 models.json 窗口算出占比。
    fn reads_session_history_usage_from_total_tokens() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            directory.path().join("models.json"),
            r#"{"providers":{"openai":{"models":[{"id":"gpt-test","name":"GPT Test","contextWindow":500000}]}}}"#,
        )
        .unwrap();
        let path = root.join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create session");
        writeln!(
            file,
            "{}",
            json!({"type":"session","id":"s1","cwd":"C:/work"})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_info","id":"n1","parentId":"s1","name":"Demo"})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"model_change","id":"m1","parentId":"n1","provider":"openai","modelId":"gpt-test"})).unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"u1","parentId":"m1","message":{"role":"user","content":"q"}})).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type":"message",
                "id":"a1",
                "parentId":"u1",
                "message":{
                    "role":"assistant",
                    "provider":"openai",
                    "model":"gpt-test",
                    "content":[{"type":"text","text":"a"}],
                    "usage":{
                        "input":26861,
                        "output":385,
                        "cacheRead":256,
                        "cacheWrite":0,
                        "reasoning":200,
                        "totalTokens":27502
                    }
                }
            }),
        )
        .unwrap();
        let previous = std::env::var_os("PI_CODING_AGENT_DIR");
        std::env::set_var("PI_CODING_AGENT_DIR", directory.path());
        let history = parse_session_history(&path, None, 20).expect("history");
        match previous {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        assert_eq!(history.context_tokens, Some(27502));
        assert_eq!(
            history.model.as_ref().unwrap()["contextWindow"],
            json!(500000)
        );
        let percent = history.context_percent.expect("percent");
        assert!((percent - 5.5004).abs() < 0.0001, "{percent}");
    }

    #[test]
    /// JSONL provider 对不上 catalog 时，按模型 id 回退窗口并算出占比。
    fn reads_session_history_usage_when_provider_mismatches_catalog() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            directory.path().join("models.json"),
            r#"{"providers":{"cp-lite":{"models":[{"id":"grok-4.6-PSYDO_GROK_SUPER","contextWindow":500000}]}}}"#,
        )
        .unwrap();
        let path = root.join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create session");
        writeln!(
            file,
            "{}",
            json!({"type":"session","id":"s1","cwd":"C:/work"})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_info","id":"n1","parentId":"s1","name":"iris"})
        )
        .unwrap();
        writeln!(file, "{}", json!({"type":"model_change","id":"m1","parentId":"n1","provider":"provider","modelId":"grok-4.6-PSYDO_GROK_SUPER"})).unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"u1","parentId":"m1","message":{"role":"user","content":"q"}})).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type":"message",
                "id":"a1",
                "parentId":"u1",
                "message":{
                    "role":"assistant",
                    "provider":"provider",
                    "model":"grok-4.6-PSYDO_GROK_SUPER",
                    "content":[{"type":"text","text":"a"}],
                    "usage":{"input":1298,"output":275,"totalTokens":30501}
                }
            }),
        )
        .unwrap();
        let previous = std::env::var_os("PI_CODING_AGENT_DIR");
        std::env::set_var("PI_CODING_AGENT_DIR", directory.path());
        let history = parse_session_history(&path, None, 20).expect("history");
        match previous {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        assert_eq!(history.context_tokens, Some(30501));
        assert_eq!(
            history.model.as_ref().unwrap()["contextWindow"],
            json!(500000)
        );
        let percent = history.context_percent.expect("percent");
        assert!((percent - 6.1002).abs() < 0.0001, "{percent}");
    }

    #[test]
    /// 验证 RPC 记录按 LF 分隔并保留 Unicode 内容。
    fn parses_strict_jsonl_records() {
        assert_eq!(
            parse_rpc_line("{\"type\":\"message\",\"text\":\"中文\"}\r\n".as_bytes())
                .expect("valid line")
                .and_then(|value| value.get("text").cloned()),
            Some(json!("中文")),
        );
        assert_eq!(parse_rpc_line(b"\n").expect("empty line"), None);
        assert!(parse_rpc_line(b"not-json\n").is_err());
    }

    #[test]
    fn recommends_only_public_npm_packages() {
        assert_eq!(recommended_npm_package("pi-lens"), Some("pi-lens"));
        assert_eq!(recommended_npm_package("@kky42/pi-flow"), None);
        assert_eq!(recommended_npm_package("../evil"), None);
        assert_eq!(recommended_npm_package("sandbox.ts"), None);
    }

    #[test]
    fn reads_package_specs_from_settings() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("settings.json"),
            r#"{"packages":["npm:pi-lens","npm:pi-subagents"]}"#,
        )
        .unwrap();
        assert_eq!(
            collect_package_specs(directory.path()),
            vec!["npm:pi-lens".to_string(), "npm:pi-subagents".to_string()],
        );
    }

    #[test]
    fn reads_skill_description_from_yaml_frontmatter() {
        let folded = skill_frontmatter_description(
            "---\nname: demo\ndescription: >-\n  第一句简介。\n  第二句补充。\n---\n# Demo\n",
        )
        .expect("folded description");
        assert_eq!(folded, "第一句简介。 第二句补充。");
        assert_eq!(
            skill_frontmatter_description(
                "---\nname: find-skills\ndescription: Helps users discover skills.\n---\n",
            )
            .as_deref(),
            Some("Helps users discover skills."),
        );
        assert!(skill_frontmatter_description("# no frontmatter\n简介").is_none());
    }

    #[test]
    fn skill_dir_summary_prefers_skill_md_over_readme() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("README.md"),
            "# Title\nthis is not the description\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("SKILL.md"),
            "---\nname: demo\ndescription: 中文运维指南：创建、调用与管理 subagent。\n---\n# Demo\n",
        )
        .unwrap();
        assert_eq!(
            asset_summary(directory.path()).as_deref(),
            Some("中文运维指南：创建、调用与管理 subagent。"),
        );
    }
}
