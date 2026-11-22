//! Wire contract shared by the desktop, mobile browser and standalone host.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub supports_resume: bool,
    pub supports_fork: bool,
    pub supports_thinking: bool,
    pub supports_permission: bool,
    pub supports_images: bool,
    pub supports_file_mentions: bool,
    pub supports_queue: bool,
    pub supports_compaction: bool,
    pub supports_model_selection: bool,
    pub supports_skills: bool,
    pub supports_extension_ui: bool,
    pub supports_context_usage: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub capabilities: Capabilities,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default = "default_true")]
    pub manual: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub id: String,
    pub workspace_id: String,
    pub harness_id: String,
    pub title: String,
    #[serde(default)]
    pub native_session_id: Option<String>,
    #[serde(default)]
    pub native_session_path: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub imported: bool,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Message {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub text: String,
    pub thinking: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub tool_kind: String,
    pub arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<Value>,
    pub is_error: bool,
    pub status: String,
    pub images: Vec<Value>,
    pub streaming: bool,
    /// Unix milliseconds; 0 means the native record did not expose a usable time.
    pub created_at: u64,
    pub raw_kind: String,
    pub source_event_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostToolsPolicy {
    pub read: String,
    pub write: String,
}
impl Default for HostToolsPolicy {
    fn default() -> Self {
        Self {
            read: "allow".into(),
            write: "ask".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub options: Vec<Value>,
    pub default_value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub binding: SessionBinding,
    pub instance_id: Option<String>,
    #[serde(default)]
    pub revision: u64,
    pub state: String,
    pub capabilities: Capabilities,
    pub messages: Vec<Message>,
    pub models: Vec<Value>,
    pub model: Option<Value>,
    pub thinking_levels: Vec<String>,
    pub thinking_level: String,
    pub config_options: Vec<Value>,
    pub commands: Vec<Value>,
    pub pending_requests: Vec<PendingRequest>,
    #[serde(serialize_with = "serialize_queue")]
    pub queue: Vec<Value>,
    pub context: Value,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub statuses: serde_json::Map<String, Value>,
    pub error: Option<String>,
    pub history_loaded: bool,
    pub history_offset: usize,
    pub history_available: bool,
    pub truncated: bool,
}
impl SessionView {
    pub fn new(binding: SessionBinding) -> Self {
        Self {
            binding,
            instance_id: None,
            revision: 0,
            state: "stopped".into(),
            capabilities: Capabilities::default(),
            messages: vec![],
            models: vec![],
            model: None,
            thinking_levels: vec![],
            thinking_level: String::new(),
            config_options: vec![],
            commands: vec![],
            pending_requests: vec![],
            queue: vec![],
            context: Value::Null,
            statuses: serde_json::Map::new(),
            error: None,
            history_loaded: false,
            history_offset: 0,
            history_available: false,
            truncated: false,
        }
    }
    pub fn busy(&self) -> bool {
        matches!(
            self.state.as_str(),
            "starting" | "working" | "stopping" | "compacting"
        )
    }
}

fn serialize_queue<S: serde::Serializer>(
    queue: &[Value],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let previews = queue
        .iter()
        .enumerate()
        .map(|(index, item)| {
            serde_json::json!({
                "id": item.get("id").and_then(Value::as_str).unwrap_or(""),
                "index": index,
                "text": text(item, "text").chars().take(2000).collect::<String>(),
                "imageCount": item.get("images").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
            })
        })
        .collect::<Vec<_>>();
    previews.serialize(serializer)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub request_id: String,
    pub operation: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub protocol_version: u32,
    pub sequence: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub id: String,
    pub desktop: bool,
}
impl Principal {
    pub fn require_desktop(&self) -> Result<(), String> {
        if self.desktop {
            Ok(())
        } else {
            Err("此操作只能在本机桌面完成".into())
        }
    }
}
