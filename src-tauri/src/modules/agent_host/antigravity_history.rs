//! Read the desktop Antigravity search index without modifying its databases.
use super::{metadata, protocol::*};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn index_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".gemini/antigravity/conversation_summaries.db"))
}

fn open_index() -> Result<Connection, String> {
    let path = index_path().ok_or("无法定位 Antigravity 桌面数据")?;
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法读取 Antigravity 桌面索引：{e}"))
}

fn workspace_path(uris: &str) -> Option<PathBuf> {
    let values: Vec<String> = serde_json::from_str(uris).ok()?;
    values.into_iter().find_map(|value| {
        let path = tauri::Url::parse(&value).ok()?.to_file_path().ok()?;
        path.is_dir().then_some(path)
    })
}

pub fn desktop_cwd(native_id: &str) -> Result<PathBuf, String> {
    let db = open_index()?;
    let uris: String = db
        .query_row(
            "SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?1",
            [native_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("无法读取 Antigravity 会话工作目录：{e}"))?;
    workspace_path(&uris).ok_or_else(|| "Antigravity 会话的原始工作目录不可用".into())
}

pub fn discover() -> Result<Vec<(PathBuf, SessionBinding)>, String> {
    if !index_path().is_some_and(|path| path.is_file()) {
        return Ok(vec![]);
    }
    let db = open_index()?;
    let mut query = db.prepare(
        "SELECT s.conversation_id, s.title, s.workspace_uris, \
         COALESCE(CAST(strftime('%s', s.last_modified_time) AS INTEGER), 0) \
         FROM conversation_summaries s WHERE s.title <> '' AND EXISTS \
         (SELECT 1 FROM conversations_fts f WHERE f.conversation_id = s.conversation_id \
         AND (length(f.user_body) > 0 OR length(f.agent_body) > 0))",
    ).map_err(|e| format!("无法读取 Antigravity 桌面会话：{e}"))?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, u64>(3)?)))
        .map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for row in rows {
        let (native_id, title, uris, updated_at) = row.map_err(|e| e.to_string())?;
        let Some(cwd) = workspace_path(&uris) else { continue };
        let Some(home) = dirs::home_dir() else { continue };
        let path = home.join(".gemini/antigravity/conversations").join(format!("{native_id}.db"));
        if !path.is_file() { continue; }
        found.push((cwd, SessionBinding {
            id: metadata::stable_id("antigravity-desktop", &native_id),
            workspace_id: String::new(),
            harness_id: "acp:antigravity".into(),
            title,
            native_session_id: Some(native_id),
            native_session_path: Some(metadata::display_path(&path)),
            archived: false,
            pinned: false,
            read_only: false,
            imported: true,
            updated_at,
            preferences: SessionPreferences::default(),
        }));
    }
    Ok(found)
}

fn offsets(value: ValueRef<'_>) -> Result<Vec<(i64, usize)>, String> {
    let bytes = match value {
        ValueRef::Blob(bytes) => bytes,
        ValueRef::Text(bytes) => bytes,
        ValueRef::Null => return Ok(vec![]),
        _ => return Err("Antigravity 历史索引偏移格式无效".into()),
    };
    if bytes.is_empty() { return Ok(vec![]); }
    serde_json::from_slice(bytes).map_err(|e| format!("Antigravity 历史索引偏移无效：{e}"))
}

pub fn read(native_id: &str, before: Option<usize>) -> Result<(Vec<Message>, usize), String> {
    let db = open_index()?;
    read_index(&db, native_id, before)
}

fn read_index(db: &Connection, native_id: &str, before: Option<usize>) -> Result<(Vec<Message>, usize), String> {
    let mut query = db.prepare(
        "SELECT user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets \
         FROM conversations_fts WHERE conversation_id = ?1 ORDER BY chunk_index",
    ).map_err(|e| format!("无法读取 Antigravity 对话索引：{e}"))?;
    let mut rows = query.query([native_id]).map_err(|e| e.to_string())?;
    let mut messages = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        for (body_col, offset_col, role) in [(0, 2, "user"), (1, 3, "assistant")] {
            let body: String = row.get(body_col).map_err(|e| e.to_string())?;
            let positions = offsets(row.get_ref(offset_col).map_err(|e| e.to_string())?)?;
            for (index, &(step, start)) in positions.iter().enumerate() {
                let end = positions.get(index + 1).map(|entry| entry.1).unwrap_or(body.len());
                let value = body.get(start..end).ok_or("Antigravity 历史索引与正文不匹配")?.trim();
                if value.is_empty() { continue; }
                let id = format!("antigravity:{native_id}:{step}:{role}");
                messages.insert((step, role), Message {
                    id: id.clone(), kind: "message".into(), role: role.into(),
                    text: value.into(), status: "completed".into(),
                    raw_kind: "antigravity_desktop_index".into(),
                    source_event_id: Some(id), ..Message::default()
                });
            }
        }
    }
    let messages: Vec<Message> = messages.into_values().collect();
    if messages.is_empty() { return Err("Antigravity 桌面会话暂无可读取的历史正文".into()); }
    let end = before.unwrap_or(messages.len()).min(messages.len());
    let start = end.saturating_sub(200);
    Ok((messages[start..end].to_vec(), start))
}

pub fn is_desktop(binding: &SessionBinding) -> bool {
    binding.harness_id == "acp:antigravity"
        && binding.imported
        && binding.native_session_path.as_deref().is_some_and(|path| Path::new(path).extension().is_some_and(|ext| ext == "db"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn reads_utf8_offsets_in_step_order_and_rejects_invalid_offsets() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE conversations_fts (conversation_id TEXT, chunk_index INTEGER, user_body TEXT, agent_body TEXT, user_step_byte_offsets BLOB, agent_step_byte_offsets BLOB)").unwrap();
        db.execute(
            "INSERT INTO conversations_fts VALUES (?1, 0, ?2, ?3, ?4, ?5)",
            params!["session", "你好再见", "答复", b"[[1,0],[5,6]]".as_slice(), b"[[3,0]]".as_slice()],
        ).unwrap();
        let (messages, offset) = read_index(&db, "session", None).unwrap();
        assert_eq!(offset, 0);
        assert_eq!(messages.iter().map(|m| (m.role.as_str(), m.text.as_str())).collect::<Vec<_>>(),
            vec![("user", "你好"), ("assistant", "答复"), ("user", "再见")]);
        db.execute("UPDATE conversations_fts SET user_step_byte_offsets = ?1", [b"[[1,1]]".as_slice()]).unwrap();
        assert!(read_index(&db, "session", None).is_err());
    }
}
