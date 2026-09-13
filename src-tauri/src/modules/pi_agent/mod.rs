use crate::modules::proc::hide_console;
#[cfg(windows)]
use crate::modules::proc::job::ProcessJob;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
const JSONL_CHUNK: u64 = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiListedModel {
    provider: String,
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
}

struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pid: u32,
    #[cfg(windows)]
    _job: Option<ProcessJob>,
}

pub struct PiAgentState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAsset {
    name: String,
    path: String,
    source: String,
    summary: Option<String>,
}

/// 扫描 Pi 技能或插件目录，返回只读展示所需的轻量元数据。
#[tauri::command]
pub fn pi_agent_list_assets(kind: String) -> Result<Vec<PiAsset>, String> {
    let home = dirs::home_dir().ok_or("无法定位用户目录")?;
    let roots: Vec<(PathBuf, String)> = match kind.as_str() {
        "skills" => vec![
            (home.join(".pi").join("agent").join("skills"), "Pi 技能".into()),
            (home.join(".agents").join("skills"), "共享技能".into()),
        ],
        "plugins" => vec![(home.join(".pi").join("agent").join("extensions"), "Pi 插件".into())],
        _ => return Err("kind 必须是 skills 或 plugins".into()),
    };
    let mut assets = Vec::new();
    for (root, source) in roots {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            let summary = ["README.md", "README.txt", "package.json"]
                .iter()
                .find_map(|file| fs::read_to_string(path.join(file)).ok())
                .map(|text| text.lines().take(3).collect::<Vec<_>>().join(" "))
                .map(|text| text.chars().take(240).collect());
            assets.push(PiAsset { name, path: canonical_display(&path), source: source.clone(), summary });
        }
    }
    assets.sort_by_key(|asset| asset.name.to_lowercase());
    Ok(assets)
}

/// 监听原生会话目录，兼容任何 Pi 客户端新建或更新的会话。
#[tauri::command]
pub fn pi_agent_watch_sessions(app: AppHandle, state: State<'_, PiAgentState>, enabled: bool) -> Result<(), String> {
    use notify::Watcher;
    let mut slot = state.watcher.lock().map_err(|_| "会话监听锁不可用")?;
    if !enabled { *slot = None; return Ok(()); }
    if slot.is_some() { return Ok(()); }
    let root = pi_sessions_dir().ok_or("Pi 会话目录不可用")?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if matches!(event.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_) | notify::EventKind::Remove(_)) {
                let _ = app.emit("codev://pi-sessions-changed", ());
            }
        }
    }).map_err(|error| error.to_string())?;
    watcher.watch(&root, notify::RecursiveMode::Recursive).map_err(|error| error.to_string())?;
    *slot = Some(watcher);
    Ok(())
}

impl Drop for PiAgentState {
    /// 在应用退出时终止仍由 Codev 管理的 Pi 子进程。
    fn drop(&mut self) {
        close_all_processes(&self.sessions);
    }
}

/// 将路径转换为前端统一使用的正斜线格式。
fn canonical_display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 判断给定路径是否是可用文件。
fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

/// 按自定义路径、PATH 和用户 npm 目录依次寻找 Pi。
fn resolve_pi_binary(custom_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = custom_path.map(str::trim).filter(|value| !value.is_empty()) {
        return existing_file(PathBuf::from(value))
            .ok_or_else(|| format!("Pi 可执行文件不存在：{value}"));
    }

    let names: &[&str] = if cfg!(windows) {
        &["pi.exe", "pi.cmd", "pi.bat", "pi.ps1", "pi"]
    } else {
        &["pi"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in names {
                if let Some(found) = existing_file(directory.join(name)) {
                    return Ok(found);
                }
            }
        }
    }

    #[cfg(windows)]
    if let Some(data) = dirs::data_dir() {
        for name in names {
            if let Some(found) = existing_file(data.join("npm").join(name)) {
                return Ok(found);
            }
        }
    }

    Err("未找到 Pi，请先安装 Pi Coding Agent 并确保 pi 位于 PATH".to_string())
}

/// 创建可直接使用 stdin/stdout 管道的 Pi 命令。
fn create_pi_command(path: &Path, args: &[String]) -> Command {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(windows)]
    let mut command = if extension == "cmd" || extension == "bat" {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]).arg(path).args(args);
        command
    } else if extension == "ps1" {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(path)
            .args(args);
        command
    } else {
        let mut command = Command::new(path);
        command.args(args);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(path);
        command.args(args);
        command
    };

    hide_console(&mut command);
    command
}

/// 执行 Pi 版本探测并提取首行版本号。
fn probe_binary(path: &Path) -> Result<String, String> {
    let output = create_pi_command(path, &["--version".to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Pi 版本探测失败：{}", output.status)
        } else {
            message
        });
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        Err("Pi 未返回版本号".to_string())
    } else {
        Ok(version)
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

/// 返回 Pi 原生会话目录。
fn pi_sessions_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .map(|path| path.join("sessions"))
}

/// 将路径标准化后进行当前平台语义下的比较。
fn same_path(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        let value = value.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    normalize(left) == normalize(right)
}

/// 从消息内容中提取第一段用户文本作为线程预览。
fn message_preview(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let text = if let Some(value) = content.as_str() {
        value.to_string()
    } else {
        content
            .as_array()?
            .iter()
            .find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
            })?
            .to_string()
    };
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact.chars().take(80).collect())
    }
}

/// 解析一个 Pi JSONL 文件的轻量线程摘要。
fn parse_session_summary(path: &Path, expected_cwd: Option<&str>) -> Option<PiSessionSummary> {
    let file = File::open(path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut name = None;
    let mut preview = None;
    let mut message_count = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                id = value.get("id").and_then(Value::as_str).map(str::to_string);
                cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
                created_at = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(expected) = expected_cwd {
                    if !cwd
                        .as_deref()
                        .is_some_and(|value| same_path(value, expected))
                    {
                        return None;
                    }
                }
            }
            Some("session_info") => {
                name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("message") => {
                message_count += 1;
                if preview.is_none() {
                    preview = value.get("message").and_then(message_preview);
                }
            }
            _ => {}
        }
    }

    let metadata = path.metadata().ok()?;
    let updated_at = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(PiSessionSummary {
        path: canonical_display(path),
        id: id?,
        cwd: cwd?,
        name,
        preview,
        created_at: created_at.unwrap_or_default(),
        updated_at,
        message_count,
    })
}

/// 校验路径是 Pi 会话目录内的 jsonl 文件。
fn resolve_session_file(path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    let root = pi_sessions_dir()
        .ok_or("无法定位 Pi 会话目录")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(&root)
        || !resolved.is_file()
        || resolved.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("仅允许使用 Pi 会话目录中的会话文件".into());
    }
    Ok(resolved)
}

fn is_leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

/// 生成 UTC RFC3339 时间，避免引入 chrono。
fn utc_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut days = duration.as_secs() / 86400;
    let remain = duration.as_secs() % 86400;
    let hour = remain / 3600;
    let minute = (remain % 3600) / 60;
    let second = remain % 60;
    let millis = duration.subsec_millis();
    let mut year = 1970u64;
    loop {
        let year_days = if is_leap(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let month_days = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for days_in_month in month_days {
        if days < days_in_month {
            break;
        }
        days -= days_in_month;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        day = days + 1
    )
}

fn new_entry_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
        now.as_secs() as u32,
        (now.subsec_nanos() >> 16) as u16,
        now.subsec_nanos() & 0xfff,
        std::process::id() & 0xfff,
        now.as_nanos() % 0x1_0000_0000_0000
    )
}

struct JsonlRecord {
    offset: u64,
    value: Value,
}

/// 从后往前扫描 JSONL，每条记录带上文件偏移。
fn visit_jsonl_rev(
    path: &Path,
    before: u64,
    mut visit: impl FnMut(JsonlRecord) -> bool,
) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut remain = before;
    let mut tail: Vec<u8> = Vec::new();
    while remain > 0 {
        let start = remain.saturating_sub(JSONL_CHUNK);
        let length = (remain - start) as usize;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut chunk = vec![0u8; length];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        chunk.append(&mut tail);
        let mut cut = 0usize;
        if start > 0 {
            match chunk.iter().position(|&byte| byte == b'\n') {
                Some(index) => {
                    tail = chunk[..=index].to_vec();
                    cut = index + 1;
                }
                None => {
                    tail = chunk;
                    remain = start;
                    continue;
                }
            }
        }
        let region = &chunk[cut..];
        let region_start = start + cut as u64;
        let mut ranges = Vec::new();
        let mut line_start = 0usize;
        for (index, byte) in region.iter().enumerate() {
            if *byte == b'\n' {
                let mut line_end = index;
                if line_end > line_start && region[line_end - 1] == b'\r' {
                    line_end -= 1;
                }
                ranges.push((region_start + line_start as u64, line_start, line_end));
                line_start = index + 1;
            }
        }
        if line_start < region.len() {
            let mut line_end = region.len();
            if line_end > line_start && region[line_end - 1] == b'\r' {
                line_end -= 1;
            }
            ranges.push((region_start + line_start as u64, line_start, line_end));
        }
        for (offset, from, to) in ranges.into_iter().rev() {
            if from >= to {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&region[from..to]) {
                if !visit(JsonlRecord { offset, value }) {
                    return Ok(());
                }
            }
        }
        remain = start;
    }
    Ok(())
}

fn usage_tokens(usage: &Value) -> Option<u64> {
    usage
        .get("totalTokens")
        .or_else(|| usage.get("tokens"))
        .or_else(|| usage.get("inputTokens"))
        .or_else(|| usage.get("input"))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|number| number.round() as u64))
        })
}

fn context_ratio(tokens: u64, window: u64) -> f64 {
    ((tokens as f64) / (window as f64) * 100.0).min(100.0)
}

fn find_listed_model<'a>(
    models: &'a [PiListedModel],
    provider: &str,
    id: &str,
) -> Option<&'a PiListedModel> {
    if let Some(exact) = models
        .iter()
        .find(|listed| listed.provider == provider && listed.id == id)
    {
        return Some(exact);
    }
    let matches: Vec<_> = models.iter().filter(|listed| listed.id == id).collect();
    match matches.as_slice() {
        [] => None,
        [only] => Some(*only),
        many => many
            .iter()
            .copied()
            .max_by_key(|listed| listed.context_window.unwrap_or(0)),
    }
}

fn apply_catalog_window(
    model: &mut Value,
    context_tokens: Option<u64>,
    context_percent: &mut Option<f64>,
) {
    let Some(provider) = model
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some(id) = model.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let Ok(models) = list_models_from_file() else {
        return;
    };
    let Some(listed) = find_listed_model(&models, &provider, &id) else {
        return;
    };
    if model.get("name").and_then(Value::as_str).is_none() {
        if let Some(name) = &listed.name {
            model["name"] = json!(name);
        }
    }
    let Some(window) = listed.context_window.filter(|window| *window > 0) else {
        return;
    };
    if model.get("contextWindow").is_none() {
        model["contextWindow"] = json!(window);
    }
    if context_percent.is_none() {
        if let Some(tokens) = context_tokens {
            *context_percent = Some(context_ratio(tokens, window));
        }
    }
}

fn assistant_model(message: &Value) -> Option<Value> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let provider = message.get("provider").and_then(Value::as_str)?;
    let id = message
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| message.get("modelId").and_then(Value::as_str))?;
    Some(json!({
        "provider": provider,
        "id": id,
        "name": message.get("name").and_then(Value::as_str),
    }))
}

fn peek_session_name(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut name = None;
    for _ in 0..48 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            if let Some(value) = value.get("name").and_then(Value::as_str) {
                name = Some(value.to_string());
            }
        }
    }
    name
}

fn last_entry_id(path: &Path) -> Result<Value, String> {
    let size = path
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let mut found = Value::Null;
    visit_jsonl_rev(path, size, |record| {
        if record.value.get("type").and_then(Value::as_str) == Some("session") {
            return true;
        }
        if let Some(id) = record.value.get("id").cloned() {
            found = id;
            return false;
        }
        true
    })?;
    Ok(found)
}

/// 从末尾分页读取消息，并带回模型、会话名称和思考等级，不启动 Pi runtime。
fn parse_session_history(
    path: &Path,
    before: Option<u64>,
    limit: usize,
) -> Result<PiSessionHistory, String> {
    let resolved = resolve_session_file(path)?;
    let file_len = resolved
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let end = before.unwrap_or(file_len).min(file_len);
    let page = limit.max(1);
    let mut newest_first = Vec::new();
    let mut model = None;
    let mut thinking_level = None;
    let mut session_name = None;
    let mut oldest_offset = 0;
    let mut has_more = false;
    let mut context_tokens = None;
    let mut context_percent = None;
    visit_jsonl_rev(&resolved, end, |record| {
        match record.value.get("type").and_then(Value::as_str) {
            Some("session_info") if session_name.is_none() => {
                session_name = record
                    .value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                true
            }
            Some("model_change") if model.is_none() => {
                if let (Some(provider), Some(id)) = (
                    record.value.get("provider").and_then(Value::as_str),
                    record.value.get("modelId").and_then(Value::as_str),
                ) {
                    model = Some(json!({
                        "provider": provider,
                        "id": id,
                        "name": record.value.get("name").and_then(Value::as_str),
                    }));
                }
                true
            }
            Some("thinking_level_change") if thinking_level.is_none() => {
                thinking_level = record
                    .value
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                true
            }
            Some("message") => {
                let Some(message) = record.value.get("message").cloned() else {
                    return true;
                };
                let usage = message.get("usage").or_else(|| record.value.get("usage"));
                let context = usage.and_then(|value| value.get("contextUsage")).or(usage);
                if let Some(context) = context {
                    if context_tokens.is_none() {
                        context_tokens = usage_tokens(context);
                    }
                    if context_percent.is_none() {
                        context_percent = context.get("percent").and_then(Value::as_f64);
                    }
                }
                if model.is_none() {
                    model = assistant_model(&message);
                }
                if newest_first.len() < page {
                    newest_first.push(json!({
                        "id": record.value.get("id"),
                        "timestamp": record.value.get("timestamp"),
                        "message": message,
                    }));
                    oldest_offset = record.offset;
                } else {
                    has_more = true;
                }
                newest_first.len() < page
                    || model.is_none()
                    || thinking_level.is_none()
                    || session_name.is_none()
                    || context_tokens.is_none()
            }
            _ => {
                newest_first.len() < page
                    || model.is_none()
                    || thinking_level.is_none()
                    || session_name.is_none()
                    || context_tokens.is_none()
            }
        }
    })?;
    if session_name.is_none() && before.is_none() {
        session_name = peek_session_name(&resolved);
    }
    newest_first.reverse();
    if let Some(model) = model.as_mut() {
        apply_catalog_window(model, context_tokens, &mut context_percent);
    }
    Ok(PiSessionHistory {
        messages: newest_first,
        model,
        thinking_level,
        session_name,
        session_file: canonical_display(&resolved),
        oldest_offset,
        has_more,
        context_tokens,
        context_percent,
    })
}

fn clone_session_file(path: &Path) -> Result<PiClonedSession, String> {
    let source = resolve_session_file(path)?;
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let mut lines = content.lines();
    let header_line = lines.next().ok_or("会话文件为空")?;
    let mut header: Value =
        serde_json::from_str(header_line).map_err(|error| error.to_string())?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("会话头无效".into());
    }
    let new_id = new_entry_id();
    let timestamp = utc_timestamp();
    header["id"] = json!(new_id);
    header["timestamp"] = json!(timestamp);
    header["parentSession"] = json!(canonical_display(&source));
    let directory = source.parent().ok_or("会话目录不存在")?;
    let file_stamp = timestamp.replace(':', "-");
    let dest = directory.join(format!("{file_stamp}_{new_id}.jsonl"));
    let mut output = header.to_string();
    output.push('\n');
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }
    fs::write(&dest, output).map_err(|error| error.to_string())?;
    Ok(PiClonedSession {
        path: canonical_display(&dest),
        id: new_id,
        name: None,
    })
}

fn append_session_entry(request: PiSessionAppendRequest) -> Result<(), String> {
    let path = resolve_session_file(Path::new(&request.path))?;
    let parent_id = last_entry_id(&path)?;
    let id = new_entry_id();
    let timestamp = utc_timestamp();
    let entry = match request.kind.as_str() {
        "session_info" => json!({
            "type": "session_info",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "name": request.name.filter(|value| !value.trim().is_empty()).ok_or("缺少会话名称")?,
        }),
        "model_change" => json!({
            "type": "model_change",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "provider": request.provider.filter(|value| !value.trim().is_empty()).ok_or("缺少 provider")?,
            "modelId": request.model_id.filter(|value| !value.trim().is_empty()).ok_or("缺少 modelId")?,
        }),
        "thinking_level_change" => json!({
            "type": "thinking_level_change",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "thinkingLevel": request.thinking_level.filter(|value| !value.trim().is_empty()).ok_or("缺少 thinkingLevel")?,
        }),
        _ => return Err("不支持的会话写入类型".into()),
    };
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{entry}").map_err(|error| error.to_string())
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

/// 扫描会话目录并返回属于指定工作目录的最近线程。
fn list_sessions(cwd: Option<&str>, limit: usize) -> Vec<PiSessionSummary> {
    let Some(root) = pi_sessions_dir() else {
        return Vec::new();
    };
    let mut pending = vec![root];
    let mut summaries = Vec::new();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                if let Some(summary) = parse_session_summary(&path, cwd) {
                    summaries.push(summary);
                }
            }
        }
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    summaries.truncate(limit);
    summaries
}

/// 异步列出当前工作目录对应的 Pi 原生线程。
#[tauri::command]
pub async fn pi_agent_list_sessions(
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<PiSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions(Some(&cwd), limit.unwrap_or(100)))
        .await
        .map_err(|error| error.to_string())
}

/// 异步列出所有 Pi 原生线程，供前端按 cwd 分组。
#[tauri::command]
pub async fn pi_agent_list_all_sessions(
    limit: Option<usize>,
) -> Result<Vec<PiSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions(None, limit.unwrap_or(usize::MAX)))
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

/// 校验真实路径与会话格式后仅删除该文件。
fn delete_session_file(root: &Path, target: &Path) -> Result<(), String> {
    let resolved = target.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.starts_with(root)
        || !resolved.is_file()
        || resolved.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || parse_session_summary(&resolved, None).is_none()
    {
        return Err("仅允许删除 Pi 会话目录中的会话文件".into());
    }
    std::fs::remove_file(resolved).map_err(|error| error.to_string())
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
    use super::{
        append_session_entry, clone_session_file, delete_session_file, message_preview,
        parse_rpc_line, parse_session_history, parse_session_summary, same_path,
        PiSessionAppendRequest,
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
        writeln!(file, "{}", json!({"type":"session","id":"s1","cwd":"C:/work"})).unwrap();
        writeln!(file, "{}", json!({"type":"session_info","id":"n1","parentId":"s1","name":"Demo"})).unwrap();
        writeln!(file, "{}", json!({"type":"thinking_level_change","id":"t1","parentId":"n1","thinkingLevel":"high"})).unwrap();
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
        assert_eq!(std::fs::read_to_string(&cloned.path).unwrap().contains("\"name\":\"Fork\""), true);
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
        writeln!(file, "{}", json!({"type":"session","id":"s1","cwd":"C:/work"})).unwrap();
        writeln!(file, "{}", json!({"type":"session_info","id":"n1","parentId":"s1","name":"Demo"})).unwrap();
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
        assert_eq!(history.model.as_ref().unwrap()["contextWindow"], json!(500000));
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
        writeln!(file, "{}", json!({"type":"session","id":"s1","cwd":"C:/work"})).unwrap();
        writeln!(file, "{}", json!({"type":"session_info","id":"n1","parentId":"s1","name":"iris"})).unwrap();
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
        assert_eq!(history.model.as_ref().unwrap()["contextWindow"], json!(500000));
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
}
