use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;

#[derive(Default)]
pub(super) struct Activity {
    pub pending: HashSet<String>,
    pub requests: HashSet<String>,
    pub active: HashSet<String>,
    pub unknown: bool,
    pub ready: bool,
    pub internal: HashMap<String, Sender<Value>>,
}

impl Activity {
    /// 从完整连接事件跟踪运行状态，包含未显示的线程与子线程。
    pub fn receive(&mut self, message: &Value) {
        let method = message["method"].as_str().unwrap_or("");
        if let Some(id) = message.get("id") {
            let id = id.to_string();
            if method.is_empty() {
                self.pending.remove(&id);
            } else {
                self.requests.insert(id);
            }
        }
        let params = &message["params"];
        let thread = params["threadId"].as_str().unwrap_or("");
        match method {
            "turn/started" => {
                self.active.insert(thread.into());
            }
            "turn/completed" | "thread/closed" => {
                self.active.remove(thread);
            }
            "thread/status/changed" => match params["status"]["type"].as_str() {
                Some("active") => {
                    self.active.insert(thread.into());
                }
                Some("idle" | "notLoaded") => {
                    self.active.remove(thread);
                }
                _ => {
                    self.unknown = true;
                }
            },
            "serverRequest/resolved" => {
                self.requests.remove(&params["requestId"].to_string());
            }
            _ => {}
        }
    }

    /// 所有请求和活动都结束且连接已握手，才允许进行原生最终核验。
    pub fn check(&self) -> Result<(), String> {
        if self.unknown || !self.ready {
            return Err("运行状态未知，请先重新连接 Codex".into());
        }
        if !self.active.is_empty() || !self.requests.is_empty() || !self.pending.is_empty() {
            return Err("仍有任务、审批或请求未结束，请稍后切换资源".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 隐藏会话和待审批不会被当前视口的空闲状态覆盖。
    #[test]
    fn tracks_hidden_threads_and_approvals() {
        let mut state = Activity {
            ready: true,
            ..Default::default()
        };
        state.receive(&json!({"method":"turn/started","params":{"threadId":"hidden"}}));
        state.receive(&json!({"id":4,"method":"item/commandExecution/requestApproval","params":{"threadId":"hidden"}}));
        state.receive(&json!({"method":"turn/completed","params":{"threadId":"hidden"}}));
        assert!(state.check().is_err());
        state.receive(&json!({"method":"serverRequest/resolved","params":{"requestId":4}}));
        assert!(state.check().is_ok());
        state.unknown = true;
        assert!(state.check().is_err());
    }
}
