use crate::modules::proc::hide_console;
#[cfg(windows)]
use crate::modules::proc::job::ProcessJob;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::sync::{mpsc, Arc};
use tauri::{AppHandle, Emitter, State};
mod activity;
pub mod resources;
use activity::Activity;

const EVENT: &str = "codev://codex-agent-event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    connection_id: u64,
    message: Value,
}

struct Process {
    id: u64,
    owner: String,
    child: Child,
    stdin: Option<ChildStdin>,
    activity: Arc<Mutex<Activity>>,
    resource_id: String,
    provider: String,
    next_query: u64,
    #[cfg(windows)]
    _job: ProcessJob,
}

impl Drop for Process {
    /// 仅回收本插件创建的 app-server，避免留下孤儿进程。
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct CodexAgentState {
    process: Mutex<Option<Process>>,
    next_id: AtomicU64,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// 监听独立 Codex 历史目录，向前端发送发生变更的会话路径。
#[tauri::command]
pub fn codex_agent_watch_sessions(
    app: AppHandle,
    state: State<'_, CodexAgentState>,
    enabled: bool,
) -> Result<(), String> {
    use notify::Watcher;
    let mut slot = state.watcher.lock().map_err(|_| "会话监听锁不可用")?;
    if !enabled {
        *slot = None;
        return Ok(());
    }
    if slot.is_some() {
        return Ok(());
    }
    let root = resources::home()?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    let _ = app.emit("codev://codex-sessions-changed", paths);
                }
            }
        }
    })
    .map_err(|error| error.to_string())?;
    for folder in ["sessions", "archived_sessions"] {
        let path = root.join(folder);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        watcher
            .watch(&path, notify::RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
    }
    *slot = Some(watcher);
    Ok(())
}

/// 将用户选择导出的 Markdown 写入保存对话框指定路径。
#[tauri::command]
pub fn codex_agent_export(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|error| error.to_string())
}

impl Process {
    /// 关闭输入流使 app-server 正常落盘退出；超时保持进程记录，禁止直接启动第二个写入器。
    fn shutdown_idle(&mut self) -> Result<(), String> {
        self.stdin.take();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if self
                .child
                .try_wait()
                .map_err(|_| "无法读取 Codex 退出状态")?
                .is_some()
            {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("Codex 正在退出但尚未完成，请稍后重新连接；资源未切换".into())
    }
    /// 在持有进程操作锁时查询原生状态，阻止切换检查期间发起新任务。
    fn query(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_query += 1;
        let id = format!("codev-native-{}", self.next_query);
        let (sender, receiver) = mpsc::channel();
        self.activity
            .lock()
            .map_err(|_| "状态锁不可用")?
            .internal
            .insert(id.clone(), sender);
        let result = (|| {
            let stdin = self.stdin.as_mut().ok_or("Codex 正在退出")?;
            writeln!(
                stdin,
                "{}",
                json!({"id":id,"method":method,"params":params})
            )
            .map_err(|_| "Codex 连接写入失败")?;
            stdin.flush().map_err(|_| "Codex 连接写入失败")?;
            let response = receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| "无法确认后台状态：原生查询超时")?;
            if response.get("error").is_some() {
                return Err(format!("当前 Codex 无法核验 {method}，暂不可切换资源"));
            }
            response
                .get("result")
                .cloned()
                .ok_or("原生状态响应无效".into())
        })();
        self.activity
            .lock()
            .map_err(|_| "状态锁不可用")?
            .internal
            .remove(&id);
        result
    }

    /// 切换前核验所有加载线程及后台终端，不能仅依赖界面 busy 标记。
    fn verify_idle(&mut self) -> Result<(), String> {
        self.activity.lock().map_err(|_| "状态锁不可用")?.check()?;
        let mut cursor = Value::Null;
        loop {
            let result = self.query("thread/loaded/list", json!({"cursor":cursor}))?;
            let ids = result["data"].as_array().ok_or("无法读取运行线程列表")?;
            for id in ids {
                let thread =
                    self.query("thread/read", json!({"threadId":id,"includeTurns":false}))?;
                match thread["thread"]["status"]["type"].as_str() {
                    Some("idle" | "notLoaded") => {}
                    _ => return Err("仍有运行中或状态未知的线程，请稍后切换资源".into()),
                }
                let terminals = self.query(
                    "thread/backgroundTerminals/list",
                    json!({"threadId":id,"limit":1}),
                )?;
                if !terminals["data"]
                    .as_array()
                    .ok_or("无法确认后台终端状态")?
                    .is_empty()
                {
                    return Err("仍有后台终端运行，请结束对应任务后再切换资源".into());
                }
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        self.activity.lock().map_err(|_| "状态锁不可用")?.check()
    }
}

/// 从 PATH 和 Windows npm 用户安装目录寻找官方 CLI。
fn codex_command() -> Result<Command, String> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    if let Some(data) = dirs::data_dir() {
        directories.push(data.join("npm"));
    }
    let names = if cfg!(windows) {
        vec!["codex.exe", "codex.cmd"]
    } else {
        vec!["codex"]
    };
    let path = directories
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
        .ok_or("未找到 Codex CLI，请安装 @openai/codex 并加入 PATH")?;
    let mut command;
    #[cfg(windows)]
    {
        if path.extension().is_some_and(|ext| ext == "cmd") {
            let script = path
                .parent()
                .ok_or("Codex CLI 路径无效")?
                .join("node_modules/@openai/codex/bin/codex.js");
            if !script.is_file() {
                return Err("无法直接启动此 Codex shim，请使用 npm 安装官方 @openai/codex 或将 codex.exe 加入 PATH".into());
            }
            command = Command::new("node.exe");
            command.arg(script);
        } else {
            command = Command::new(path);
        }
    }
    #[cfg(not(windows))]
    {
        command = Command::new(path);
    }
    command.args(["app-server", "--listen", "stdio://"]);
    hide_console(&mut command);
    Ok(command)
}

/// 按需建立独立 stdio 连接，沿用 Codex 自身的配置和认证。
#[tauri::command]
pub fn codex_agent_start(
    app: AppHandle,
    state: State<'_, CodexAgentState>,
    owner: String,
    resource_id: Option<String>,
) -> Result<u64, String> {
    let mut slot = state.process.lock().map_err(|e| e.to_string())?;
    if let Some(process) = slot.as_mut() {
        if process.owner == owner
            && process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
        {
            return Ok(process.id);
        }
        if process
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            process.verify_idle()?;
            process.shutdown_idle()?;
        }
    }
    *slot = None;
    let mut command = codex_command()?;
    let (resource_id, provider, secret) =
        resources::configure(&mut command, resource_id.as_deref())?;
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 Codex 失败：{e}"))?;
    #[cfg(windows)]
    let job = match ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let stdin = child.stdin.take().ok_or("Codex stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("Codex stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Codex stderr 不可用")?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let activity = Arc::new(Mutex::new(Activity::default()));
    *slot = Some(Process {
        id,
        owner,
        child,
        stdin: Some(stdin),
        activity: Arc::clone(&activity),
        resource_id,
        provider,
        next_query: 0,
        #[cfg(windows)]
        _job: job,
    });
    let output_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        if let Ok(mut state) = activity.lock() {
                            if let Some(id) = message["id"].as_str() {
                                if let Some(sender) = state.internal.remove(id) {
                                    let _ = sender.send(message);
                                    continue;
                                }
                            }
                            state.receive(&message);
                        }
                        let message = redact(message, secret.as_deref());
                        let _ = output_app.emit(
                            EVENT,
                            Envelope {
                                connection_id: id,
                                message,
                            },
                        );
                    }
                    Err(error) => {
                        if let Ok(mut state) = activity.lock() {
                            state.unknown = true;
                        }
                        let _ = output_app.emit(EVENT, Envelope { connection_id: id, message: json!({"method":"bridge/error","params":{"message":format!("无效协议消息：{error}")}}) });
                    }
                },
                Err(_) => break,
            }
        }
        if let Ok(mut state) = activity.lock() {
            state.unknown = true;
            state.internal.clear();
        }
        let _ = output_app.emit(
            EVENT,
            Envelope {
                connection_id: id,
                message: json!({"method":"bridge/closed"}),
            },
        );
    });
    std::thread::spawn(move || {
        // 消费诊断流避免管道阻塞，凭据环境的诊断不转发到前端或日志。
        for _ in BufReader::new(stderr).lines().map_while(Result::ok) {}
    });
    Ok(id)
}

/// 对协议字符串中的本插件密钥做脱敏，避免错误回显泄漏。
fn redact(mut value: Value, secret: Option<&str>) -> Value {
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        match &mut value {
            Value::String(text) => *text = text.replace(secret, "[REDACTED]"),
            Value::Array(items) => {
                for item in items {
                    *item = redact(item.take(), Some(secret));
                }
            }
            Value::Object(items) => {
                for item in items.values_mut() {
                    *item = redact(item.take(), Some(secret));
                }
            }
            _ => {}
        }
    }
    value
}

/// 握手后确认资源生效并持久化选择，不在启动失败时写入。
#[tauri::command]
pub fn codex_agent_ready(
    state: State<'_, CodexAgentState>,
    connection_id: u64,
) -> Result<Value, String> {
    let mut slot = state.process.lock().map_err(|_| "进程锁不可用")?;
    let process = slot
        .as_mut()
        .filter(|p| p.id == connection_id)
        .ok_or("Codex 连接已关闭")?;
    resources::commit(&process.resource_id)?;
    process.activity.lock().map_err(|_| "状态锁不可用")?.ready = true;
    Ok(
        json!({"resourceId":process.resource_id,"provider":process.provider,"lastModel":resources::last_model(&process.resource_id, &process.provider)?}),
    )
}

/// 在原生核验期间保持进程操作锁，成功后才释放旧 runtime。
#[tauri::command]
pub async fn codex_agent_prepare_switch(
    app: AppHandle,
    connection_id: u64,
    resource_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<CodexAgentState>();
        let mut slot = state.process.lock().map_err(|_| "进程锁不可用")?;
        let process = slot
            .as_mut()
            .filter(|p| p.id == connection_id)
            .ok_or("连接已改变，请重试")?;
        let (_, provider, _) = resources::configure(&mut codex_command()?, Some(&resource_id))?;
        if provider != process.provider {
            return Err("原生 provider 已改变，请重新连接后再切换资源".into());
        }
        process.verify_idle()?;
        process.shutdown_idle()?;
        *slot = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 写入一条 JSONL 消息，连接编号阻止旧页面误操作新进程。
#[tauri::command]
pub fn codex_agent_send(
    state: State<'_, CodexAgentState>,
    connection_id: u64,
    message: Value,
) -> Result<(), String> {
    let mut slot = state.process.lock().map_err(|e| e.to_string())?;
    let process = slot
        .as_mut()
        .filter(|p| p.id == connection_id)
        .ok_or("Codex 连接已关闭")?;
    let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    if let Some(id) = message.get("id") {
        let mut activity = process.activity.lock().map_err(|_| "状态锁不可用")?;
        if message.get("method").is_some() {
            activity.pending.insert(id.to_string());
        } else {
            activity.requests.remove(&id.to_string());
        }
    }
    bytes.push(b'\n');
    process
        .stdin
        .as_mut()
        .ok_or("Codex 正在退出")?
        .write_all(&bytes)
        .and_then(|_| process.stdin.as_mut().unwrap().flush())
        .map_err(|e| e.to_string())
}

/// 禁用插件或退出 Codev 时结束独立连接。
#[tauri::command]
pub fn codex_agent_close(
    state: State<'_, CodexAgentState>,
    connection_id: Option<u64>,
) -> Result<(), String> {
    let mut slot = state.process.lock().map_err(|e| e.to_string())?;
    if connection_id.is_none() || slot.as_ref().is_some_and(|p| Some(p.id) == connection_id) {
        *slot = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证真实 CLI 接受资源覆盖、后台核验与正常退出，全程使用临时目录和假 key。
    #[test]
    #[ignore = "requires installed Codex CLI; no model calls"]
    fn installed_cli_resource_switch_checks() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("config.toml"), "model_provider = \"codev_qa\"\nmodel = \"gpt-5.4\"\n[model_providers.codev_qa]\nname = \"QA\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"http://127.0.0.1:1/native/v1\"\n").unwrap();
        std::fs::write(
            root.path().join("auth.json"),
            "{\"OPENAI_API_KEY\":\"fake-original\"}",
        )
        .unwrap();
        resources::fake_resource(root.path());
        let mut command = codex_command().unwrap();
        let (resource_id, provider, _) =
            resources::configure_at(&mut command, Some("fake"), root.path()).unwrap();
        command
            .env("CODEX_HOME", root.path())
            .current_dir(root.path());
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        #[cfg(windows)]
        let job = ProcessJob::create_for(child.id()).unwrap();
        let activity = Arc::new(Mutex::new(Activity::default()));
        let reader = Arc::clone(&activity);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    let mut state = reader.lock().unwrap();
                    if let Some(sender) = message["id"]
                        .as_str()
                        .and_then(|id| state.internal.remove(id))
                    {
                        let _ = sender.send(message);
                    } else {
                        state.receive(&message);
                    }
                }
            }
        });
        let mut process = Process {
            id: 1,
            owner: "test".into(),
            child,
            stdin: Some(stdin),
            activity,
            resource_id,
            provider,
            next_query: 0,
            #[cfg(windows)]
            _job: job,
        };
        process.query("initialize", json!({"clientInfo":{"name":"codev_resources_qa","version":"1"},"capabilities":{"experimentalApi":true}})).unwrap();
        writeln!(
            process.stdin.as_mut().unwrap(),
            "{}",
            json!({"method":"initialized"})
        )
        .unwrap();
        process.stdin.as_mut().unwrap().flush().unwrap();
        process.activity.lock().unwrap().ready = true;
        let config = process.query("config/read", json!({})).unwrap();
        assert_eq!(config["config"]["model_provider"], "codev_qa");
        assert_eq!(
            config["config"]["model_providers"]["codev_qa"]["base_url"],
            "http://127.0.0.1:1/qa/v1"
        );
        assert_eq!(
            config["config"]["model_providers"]["codev_qa"]["requires_openai_auth"],
            false
        );
        let thread = process
            .query(
                "thread/start",
                json!({"cwd":root.path(),"sandbox":"danger-full-access"}),
            )
            .unwrap();
        assert_eq!(thread["modelProvider"], "codev_qa");
        process.verify_idle().unwrap();
        process
            .activity
            .lock()
            .unwrap()
            .active
            .insert("hidden".into());
        assert!(process.verify_idle().is_err());
        process.activity.lock().unwrap().active.clear();
        process.shutdown_idle().unwrap();
        assert!(process.child.try_wait().unwrap().is_some());
        assert!(std::fs::read_to_string(root.path().join("auth.json"))
            .unwrap()
            .contains("fake-original"));
    }

    /// 仅验证本机 CLI 握手和列表协议，不生成模型请求或修改会话。
    #[test]
    #[ignore = "requires an installed Codex CLI"]
    fn installed_cli_stdio_handshake() {
        let mut child = codex_command()
            .expect("resolve CLI")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn CLI");
        let stdout = child.stdout.take().expect("stdout");
        let stdin = child.stdin.take().expect("stdin");
        #[cfg(windows)]
        let job = ProcessJob::create_for(child.id()).expect("assign job");
        let mut process = Process {
            id: 1,
            owner: "test".into(),
            child,
            stdin: Some(stdin),
            activity: Arc::new(Mutex::new(Activity::default())),
            resource_id: "native".into(),
            provider: "test".into(),
            next_query: 0,
            #[cfg(windows)]
            _job: job,
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        writeln!(process.stdin.as_mut().unwrap(), "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"codev_qa","version":"1.0.2"},"capabilities":{"experimentalApi":true}}})).unwrap();
        process.stdin.as_mut().unwrap().flush().unwrap();
        let response = receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("initialize response");
        assert_eq!(response["id"], 1);
        assert!(response.get("error").is_none(), "{response}");
        writeln!(
            process.stdin.as_mut().unwrap(),
            "{}",
            json!({"method":"initialized"})
        )
        .unwrap();
        writeln!(process.stdin.as_mut().unwrap(), "{}", json!({"id":2,"method":"thread/list","params":{"limit":1,"modelProviders":[],"sortKey":"updated_at"}})).unwrap();
        process.stdin.as_mut().unwrap().flush().unwrap();
        loop {
            let response = receiver
                .recv_timeout(std::time::Duration::from_secs(30))
                .expect("thread/list response");
            if response["id"] == 2 {
                assert!(
                    response["result"]["data"].is_array(),
                    "thread/list failed: {:?}",
                    response.get("error")
                );
                break;
            }
        }
    }
}
