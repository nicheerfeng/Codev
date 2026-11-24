//! One-way import of old application metadata. Source configuration is never changed.
use super::{bridge::lock, coordinator::Host, metadata::stable_id, protocol::*};
use serde_json::Value;

impl Host {
    pub fn import_legacy_preferences(&self, config: &Value) -> Result<(), String> {
        for key in ["piAgentProjects", "codexProjects", "antigravityProjects"] {
            if let Some(projects) = config.get(key).and_then(Value::as_array) {
                for project in projects {
                    if let Some(cwd) = project.as_str() {
                        let _ = self.workspace(cwd);
                    }
                }
            }
        }
        if let Some(sessions) = config.get("antigravitySessions").and_then(Value::as_array) {
            for old in sessions {
                let native = text(old, "id");
                let cwd = text(old, "cwd");
                if native.is_empty() || native.len() > 512 || cwd.is_empty() {
                    continue;
                }
                let id = stable_id("antigravity", &native);
                if lock(&self.state).sessions.values().any(|s| {
                    s.binding.id == id
                        || (s.binding.harness_id == "acp:antigravity"
                            && s.binding.native_session_id.as_deref() == Some(native.as_str()))
                }) {
                    continue;
                }
                let Ok(workspace) = self.workspace(&cwd) else {
                    continue;
                };
                let title = text(old, "title");
                let timestamp = old.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
                let timestamp = if timestamp > 10_000_000_000 {
                    timestamp / 1000
                } else {
                    timestamp
                };
                let binding = SessionBinding {
                    id: id.clone(),
                    workspace_id: workspace.id,
                    harness_id: "acp:antigravity".into(),
                    title: if title.is_empty() {
                        "Antigravity 历史会话".into()
                    } else {
                        title.chars().take(160).collect()
                    },
                    native_session_id: Some(native),
                    native_session_path: None,
                    archived: false,
                    pinned: false,
                    read_only: false,
                    imported: true,
                    updated_at: timestamp,
                    preferences: SessionPreferences::default(),
                };
                lock(&self.store).save_session(&binding)?;
                let mut state = lock(&self.state);
                state.sessions.insert(id, SessionView::new(binding));
                state.global_dirty = true;
            }
        }
        Ok(())
    }
}
