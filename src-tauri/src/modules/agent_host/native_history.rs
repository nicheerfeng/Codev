//! Discover native session summaries without importing transcript contents.
use super::{antigravity_history, history, metadata, protocol::*};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone)]
struct CachedSummary {
    modified: Option<SystemTime>,
    size: u64,
    value: Option<(PathBuf, SessionBinding)>,
}

#[derive(Default)]
pub struct NativeHistory {
    cache: HashMap<PathBuf, CachedSummary>,
}

impl NativeHistory {
    pub fn scan(&mut self, workspaces: &[Workspace]) -> (Vec<(PathBuf, SessionBinding)>, Vec<String>) {
        let mut found = Vec::new();
        let mut errors = Vec::new();
        if let Some(home) = history::pi_home() {
            for workspace in workspaces {
                let directory = format!("--{}--", workspace.cwd.trim_start_matches(['/', '\\']).replace(['/', '\\', ':'], "-"));
                self.scan_dir(&home.join("sessions").join(directory), 1, true, false, &mut found, &mut errors);
            }
        }
        if let Some(home) = std::env::var_os("CODEX_HOME").map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex"))) {
            self.scan_dir(&home.join("sessions"), 6, false, false, &mut found, &mut errors);
            self.scan_dir(&home.join("archived_sessions"), 6, false, true, &mut found, &mut errors);
        }
        match antigravity_history::discover() {
            Ok(sessions) => found.extend(sessions),
            Err(error) => errors.push(format!("Antigravity 桌面历史读取失败：{error}")),
        }
        (found, errors)
    }

    fn scan_dir(&mut self, root: &Path, depth: usize, pi: bool, archived: bool, found: &mut Vec<(PathBuf, SessionBinding)>, errors: &mut Vec<String>) {
        if depth == 0 { return; }
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => { errors.push(format!("读取会话目录 {} 失败：{error}", root.display())); return; }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                self.scan_dir(&path, depth - 1, pi, archived, found, errors);
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                let Ok(metadata) = entry.metadata() else { continue };
                let modified = metadata.modified().ok();
                let size = metadata.len();
                let cached = self.cache.get(&path).filter(|v| v.modified == modified && v.size == size);
                let value = if let Some(cached) = cached {
                    cached.value.clone()
                } else {
                    let value = parse_summary(&path, pi, modified);
                    if value.is_some() {
                        self.cache.insert(path, CachedSummary { modified, size, value: value.clone() });
                    }
                    value
                };
                if let Some((cwd, mut binding)) = value {
                    binding.archived = archived;
                    found.push((cwd, binding));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agent_host::{bridge::lock, coordinator::Host};
    use serde_json::json;

    #[test]
    fn reads_native_titles_and_skips_codex_context_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let pi = dir.path().join("pi.jsonl");
        let cwd = dir.path().to_string_lossy();
        let pi_entries = [
            json!({"type":"session","id":"pi-1","cwd":cwd}),
            json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}),
            json!({"type":"session_info","name":"测试会话"}),
        ];
        std::fs::write(&pi, pi_entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let (_, binding) = parse_summary(&pi, true, None).unwrap();
        assert_eq!(binding.title, "测试会话");
        assert!(!binding.read_only);

        let codex = dir.path().join("codex.jsonl");
        let codex_entries = [
            json!({"type":"session_meta","payload":{"id":"codex-1","cwd":cwd}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>ignored</environment_context>"},{"type":"input_text","text":"真实问题"}]}}),
        ];
        std::fs::write(&codex, codex_entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let (_, binding) = parse_summary(&codex, false, None).unwrap();
        assert_eq!(binding.title, "真实问题");
        assert!(binding.read_only);
    }

    #[test]
    fn merges_live_sessions_and_keeps_removed_native_sessions_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let file = dir.path().join("session.jsonl");
        let entries = [
            json!({"type":"session","id":"pi-live","cwd":root}),
            json!({"type":"message","message":{"role":"user","content":"hello"}}),
        ];
        std::fs::write(&file, entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let (cwd, binding) = parse_summary(&file, true, None).unwrap();
        let host = Host::open(dir.path().join("host"), dir.path().join("web")).unwrap();
        let workspace = host.workspace(&cwd.to_string_lossy()).unwrap();
        let live_id = host.create(&workspace.id, "pi", "live").unwrap();
        host.update(&live_id, None, |view| {
            view.instance_id = Some("runtime".into());
            view.binding.native_session_id = binding.native_session_id.clone();
            view.binding.native_session_path = binding.native_session_path.clone();
        });

        host.apply_native_history(vec![(cwd.clone(), binding.clone())]).unwrap();
        assert_eq!(lock(&host.state).sessions.len(), 1);
        host.update(&live_id, None, |view| {
            view.instance_id = None;
            view.binding.title = "我的标题".into();
            view.binding.pinned = true;
        });
        host.persist(&live_id).unwrap();
        host.apply_native_history(vec![(cwd.clone(), binding.clone())]).unwrap();
        let view = host.view(&live_id).unwrap();
        assert_eq!(view.binding.title, "我的标题");
        assert!(view.binding.pinned);

        host.hide_native_session(&view.binding).unwrap();
        lock(&host.store).remove_session(&live_id).unwrap();
        lock(&host.state).sessions.remove(&live_id);
        host.apply_native_history(vec![(cwd, binding)]).unwrap();
        assert!(lock(&host.state).sessions.is_empty());
    }
}

fn user_text(value: &Value) -> Option<String> {
    let is_message = |text: &&str| {
        !text.is_empty() && !["<environment_context>", "<permissions instructions>",
            "<user_instructions>", "<collaboration_mode>", "<recommended_plugins>",
            "<system-reminder>", "# AGENTS.md"].iter().any(|prefix| text.starts_with(prefix))
    };
    if let Some(text) = value.as_str().map(str::trim).filter(is_message) {
        return Some(text.chars().take(120).collect());
    }
    value.as_array()?.iter().filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim).find(is_message).map(|text| text.chars().take(120).collect())
}

fn parse_summary(path: &Path, pi: bool, modified: Option<SystemTime>) -> Option<(PathBuf, SessionBinding)> {
    let file = std::fs::File::open(path).ok()?;
    let mut id = String::new();
    let mut cwd = String::new();
    let mut title = String::new();
    let mut first_user = None;
    let mut last_user_at = 0;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { return None };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = text(&entry, "type");
        if pi && kind == "session" {
            id = text(&entry, "id");
            cwd = text(&entry, "cwd");
        } else if !pi && kind == "session_meta" {
            let meta = entry.get("payload")?;
            id = text(meta, "id");
            cwd = text(meta, "cwd");
        } else if pi && kind == "session_info" {
            let name = text(&entry, "name");
            if !name.trim().is_empty() { title = name; }
        }
        let message = if pi && kind == "message" { entry.get("message") }
            else if !pi && kind == "response_item" { entry.get("payload") }
            else { None };
        if let Some(message) = message.filter(|m| text(m, "role") == "user") {
            if let Some(value) = message.get("content").and_then(user_text) {
                if first_user.is_none() { first_user = Some(value); }
                let timestamp = history::parse_timestamp_ms(message.get("timestamp").or_else(|| entry.get("timestamp")));
                if timestamp > 0 { last_user_at = timestamp / 1000; }
            }
        }
    }
    let first_user = first_user?;
    if id.is_empty() || cwd.is_empty() { return None; }
    let cwd = std::fs::canonicalize(cwd).ok()?;
    let path = metadata::display_path(&std::fs::canonicalize(path).ok()?);
    let harness = if pi { "pi" } else { "acp:codex" };
    let updated_at = if last_user_at > 0 { last_user_at } else {
        modified.and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
    };
    Some((cwd, SessionBinding {
        id: metadata::stable_id(harness, &id), workspace_id: String::new(),
        harness_id: harness.into(), title: if title.is_empty() { first_user } else { title },
        native_session_id: Some(id), native_session_path: Some(path),
        archived: false, pinned: false, read_only: !pi, imported: true, updated_at,
    }))
}
