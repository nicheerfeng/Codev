use crate::modules::proc::hide_console;
#[cfg(windows)]
use crate::modules::proc::job::ProcessJob;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
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

struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    #[cfg(windows)]
    _job: Option<ProcessJob>,
}

pub struct PiAgentState {
    next_id: AtomicU64,
    sessions: Arc<Mutex<HashMap<u64, PiProcess>>>,
}

impl Default for PiAgentState {
    /// 创建空的 Pi RPC 进程注册表。
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
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
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    count
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
    let mut child = process
        .child
        .lock()
        .map_err(|_| "Pi 子进程不可用".to_string())?;
    let _ = child.kill();
    let _ = child.wait();
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
fn parse_session_summary(path: &Path, expected_cwd: &str) -> Option<PiSessionSummary> {
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
                if !cwd
                    .as_deref()
                    .is_some_and(|value| same_path(value, expected_cwd))
                {
                    return None;
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

/// 扫描会话目录并返回属于指定工作目录的最近线程。
fn list_sessions(cwd: &str, limit: usize) -> Vec<PiSessionSummary> {
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
    tauri::async_runtime::spawn_blocking(move || list_sessions(&cwd, limit.unwrap_or(100)))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{message_preview, parse_rpc_line, parse_session_summary, same_path};
    use serde_json::json;
    use std::io::Write;

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
        let summary = parse_session_summary(&path, "c:/work/demo").expect("summary");
        assert_eq!(summary.id, "s1");
        assert_eq!(summary.name.as_deref(), Some("Feature"));
        assert_eq!(summary.preview.as_deref(), Some("Implement this feature"));
        assert_eq!(summary.message_count, 1);
        assert!(parse_session_summary(&path, "C:/work/other").is_none());
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
