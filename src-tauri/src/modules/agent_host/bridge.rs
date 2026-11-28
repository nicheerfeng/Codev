//! Supervised JSON-lines transport. Framing is shared; Pi and ACP correlation are explicit.
//! Architectural reference: Picot PiRpcBridge (MIT, see THIRD-PARTY-NOTICES.md).
use super::protocol::{new_id, MAX_FRAME_BYTES};
use super::registry;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Pi,
    Acp,
}
type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Bridge {
    pub wire: Wire,
    outbound: std::sync::mpsc::SyncSender<Value>,
    pending: Mutex<HashMap<String, Reply>>,
    events: mpsc::Sender<Value>,
    process: Mutex<Option<Child>>,
    diagnostics: Mutex<VecDeque<String>>,
    secrets: Mutex<Vec<String>>,
    temp_dir: Mutex<Option<PathBuf>>,
    closed: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
}

impl Bridge {
    pub fn spawn(
        path: &Path,
        args: &[String],
        cwd: &Path,
        wire: Wire,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Value>), String> {
        Self::spawn_with_env(path, args, cwd, wire, &[])
    }

    pub fn spawn_with_env(
        path: &Path,
        args: &[String],
        cwd: &Path,
        wire: Wire,
        env: &[(&str, Option<String>)],
    ) -> Result<(Arc<Self>, mpsc::Receiver<Value>), String> {
        let mut command = registry::command_for(path, args);
        command.current_dir(cwd);
        for (key, value) in env {
            if let Some(value) = value { command.env(key, value); } else { command.env_remove(key); }
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 {}：{e}", path.display()))?;
        #[cfg(windows)]
        let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
            Ok(job) => Some(job),
            Err(e) => {
                log::warn!("agent_host job-object setup failed for pid={}: {e}", child.id());
                None
            }
        };
        let stdin = child.stdin.take().ok_or("无法连接代理输入")?;
        let stdout = child.stdout.take().ok_or("无法连接代理输出")?;
        let stderr = child.stderr.take().ok_or("无法连接代理诊断输出")?;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Value>(512);
        let (events, incoming) = mpsc::channel(2048);
        let bridge = Arc::new(Self {
            wire,
            outbound: tx,
            pending: Mutex::new(HashMap::new()),
            events: events.clone(),
            process: Mutex::new(Some(child)),
            diagnostics: Mutex::new(VecDeque::new()),
            secrets: Mutex::new(env.iter().filter(|(key, _)| *key == "GEMINI_API_KEY").filter_map(|(_, value)| value.clone()).filter(|value| !value.is_empty()).collect()),
            temp_dir: Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            job: Mutex::new(job),
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::Builder::new()
            .name("agent-host-writer".into())
            .spawn(move || {
                let mut stdin = stdin;
                while let Ok(value) = rx.recv() {
                    if writeln!(stdin, "{value}")
                        .and_then(|_| stdin.flush())
                        .is_err()
                    {
                        if let Some(bridge) = weak.upgrade() {
                            bridge.fail_pending("代理输入已关闭");
                        }
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let weak = Arc::downgrade(&bridge);
        std::thread::Builder::new().name("agent-host-reader".into()).spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut buffer=Vec::new();
                match reader.by_ref().take((MAX_FRAME_BYTES+1) as u64).read_until(b'\n',&mut buffer) {
                    Ok(0)=>break,
                    Ok(_) if buffer.len()>MAX_FRAME_BYTES => {
                        let _=events.blocking_send(json!({"type":"host_protocol_error","error":"代理协议帧超过 16 MiB，连接已停止"}));
                        if let Some(b)=weak.upgrade(){b.close();} break;
                    }
                    Ok(_)=> {
                        let value:Value=match serde_json::from_slice(&buffer){Ok(v)=>v,Err(e)=>{
                            // Human startup messages are diagnostics, never protocol events.
                            if let Some(b)=weak.upgrade(){b.diagnostic(format!("协议输出：{e}"));} continue;
                        }};
                        let Some(b)=weak.upgrade() else {break};
                        let response = match wire {
                            Wire::Pi => value.get("type").and_then(Value::as_str)==Some("response"),
                            Wire::Acp => value.get("method").is_none() && value.get("id").is_some_and(|id| !id.is_null()),
                        };
                        if response {
                            if let Some(id)=value.get("id").and_then(Value::as_str) {
                                if let Some(reply)=lock(&b.pending).remove(id) {
                                    let err = value.get("error").filter(|e| !e.is_null());
                                    let result=if value.get("success")==Some(&Value::Bool(false)) || err.is_some() {
                                        Err(err.map(|e|e.as_str().map(str::to_string).unwrap_or_else(||e.to_string())).unwrap_or_else(||"代理请求失败".into()))
                                    } else {Ok(value.get(if wire==Wire::Pi{"data"}else{"result"}).cloned().unwrap_or(Value::Null))};
                                    let _=reply.send(result.map_err(|error| b.redact(&error)));
                                }
                            }
                        } else if events.blocking_send(value).is_err(){break;}
                    }
                    Err(e)=>{if let Some(b)=weak.upgrade(){b.diagnostic(e.to_string());}break;}
                }
            }
            if let Some(b)=weak.upgrade(){b.fail_pending("代理输出已关闭");}
        }).map_err(|e|e.to_string())?;
        let weak = Arc::downgrade(&bridge);
        std::thread::Builder::new()
            .name("agent-host-stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                loop {
                    let mut bytes = Vec::new();
                    match reader.by_ref().take(8192).read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some(b) = weak.upgrade() {
                                b.diagnostic(String::from_utf8_lossy(&bytes).trim().to_string());
                            } else {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok((bridge, incoming))
    }
    pub fn diagnostic(&self, line: String) {
        let line = self.redact(&line);
        let mut tail = lock(&self.diagnostics);
        if tail.len() >= 20 {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    pub fn protect_secret(&self, secret: &str) {
        if !secret.is_empty() { lock(&self.secrets).push(secret.to_string()); }
    }
    fn redact(&self, text: &str) -> String {
        lock(&self.secrets).iter().fold(text.to_string(), |value, secret| value.replace(secret, "[已隐藏]"))
    }
    pub fn diagnostic_tail(&self) -> String {
        lock(&self.diagnostics)
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn fail_pending(&self, message: &str) {
        for (_, reply) in lock(&self.pending).drain() {
            let _ = reply.send(Err(message.into()));
        }
    }
    pub fn send(&self, value: Value) -> Result<(), String> {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err("代理进程已关闭".into());
        }
        if value.to_string().len() > MAX_FRAME_BYTES {
            return Err("请求超过 16 MiB".into());
        }
        self.outbound
            .try_send(value)
            .map_err(|e| format!("代理写入队列不可用：{e}"))
    }
    pub async fn drain_events(&self) -> Result<(), String> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        if self.events.send(json!({"type":"host_event_barrier","id":id})).await.is_err() {
            lock(&self.pending).remove(&id);
            return Err("代理事件流已关闭".into());
        }
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result.map(|_| ()),
            _ => {
                lock(&self.pending).remove(&id);
                Err("等待代理历史事件超时".into())
            }
        }
    }
    pub fn finish_event_barrier(&self, id: &str) {
        if let Some(reply) = lock(&self.pending).remove(id) {
            let _ = reply.send(Ok(Value::Null));
        }
    }
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        let value = match self.wire {
            Wire::Pi => {
                let mut value = params;
                let o = value.as_object_mut().ok_or("Pi 请求参数必须是对象")?;
                o.insert("id".into(), json!(id));
                o.insert("type".into(), json!(method));
                value
            }
            Wire::Acp => json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        };
        if let Err(e) = self.send(value) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(timeout, rx).await;
        lock(&self.pending).remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("代理连接已关闭".into()),
            Err(_) => Err(format!("{method} 响应超时")),
        }
    }
    #[cfg(test)]
    pub fn for_test(wire: Wire) -> (Arc<Self>, std::sync::mpsc::Receiver<Value>) {
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        let (events, _incoming) = mpsc::channel(64);
        let bridge = Arc::new(Self {
            wire,
            outbound: tx,
            pending: Mutex::new(HashMap::new()),
            events,
            process: Mutex::new(None),
            diagnostics: Mutex::new(VecDeque::new()),
            secrets: Mutex::new(Vec::new()),
            temp_dir: Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            job: Mutex::new(None),
        });
        (bridge, rx)
    }
    #[cfg(test)]
    pub fn resolve_test(&self, id: &str, result: Result<Value, String>) {
        if let Some(reply) = lock(&self.pending).remove(id) {
            let _ = reply.send(result);
        }
    }
    pub fn poll_exit(&self) -> Result<Option<String>, String> {
        let mut guard = lock(&self.process);
        let Some(child) = guard.as_mut() else {
            return Ok(None);
        };
        child
            .try_wait()
            .map(|s| s.map(|s| s.to_string()))
            .map_err(|e| e.to_string())
    }
    pub fn close(&self) {
        if self.closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        {
            lock(&self.job).take();
        }
        if let Some(mut child) = lock(&self.process).take() {
            #[cfg(unix)]
            {
                let pid = child.id();
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                for _ in 0..3 {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        self.fail_pending("代理已停止");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(dir) = lock(&self.temp_dir).take() {
            std::thread::spawn(move || {
                let _ = std::fs::remove_dir_all(dir);
            });
        }
        self.fail_pending("代理已停止");
    }
    pub fn set_temp_dir(&self, dir: PathBuf) {
        *lock(&self.temp_dir) = Some(dir);
    }
    pub fn weak(self: &Arc<Self>) -> Weak<Self> {
        Arc::downgrade(self)
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.close();
    }
}
