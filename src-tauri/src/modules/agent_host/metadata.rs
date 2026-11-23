//! Application metadata only. Native transcripts and credentials remain owned by each CLI.
use super::protocol::*;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct MetadataStore {
    connection: Connection,
}
impl MetadataStore {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(directory.join("codev.sqlite3")).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS host_workspaces(
                     id TEXT PRIMARY KEY,
                     body TEXT NOT NULL,
                     cwd TEXT NOT NULL DEFAULT '',
                     title TEXT NOT NULL DEFAULT '',
                     manual INTEGER NOT NULL DEFAULT 1,
                     updated_at INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS host_sessions(
                     id TEXT PRIMARY KEY,
                     body TEXT NOT NULL,
                     workspace_id TEXT NOT NULL DEFAULT '',
                     harness_id TEXT NOT NULL DEFAULT '',
                     title TEXT NOT NULL DEFAULT '',
                     pinned INTEGER NOT NULL DEFAULT 0,
                     archived INTEGER NOT NULL DEFAULT 0,
                     imported INTEGER NOT NULL DEFAULT 0,
                     updated_at INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS host_preferences(key TEXT PRIMARY KEY, body TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS host_devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);",
            )
            .map_err(|e| e.to_string())?;

        connection
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_host_workspaces_manual ON host_workspaces(manual, updated_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_host_sessions_ws ON host_sessions(workspace_id, updated_at DESC);",
            )
            .map_err(|e| e.to_string())?;

        Ok(Self { connection })
    }

    fn bodies(&self, table: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(&format!("SELECT body FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn workspaces(&self) -> Result<Vec<Workspace>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT body FROM host_workspaces WHERE manual != 0")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let raw = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        raw.iter()
            .map(|s| serde_json::from_str(s).map_err(|e| e.to_string()))
            .collect()
    }
    pub fn sessions(&self) -> Result<Vec<SessionBinding>, String> {
        self.bodies("host_sessions")?
            .iter()
            .map(|s| serde_json::from_str(s).map_err(|e| e.to_string()))
            .collect()
    }
    pub fn save_workspace(&self, workspace: &Workspace) -> Result<(), String> {
        let body = serde_json::to_string(workspace).map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "INSERT INTO host_workspaces(id, body, cwd, title, manual, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     body=excluded.body,
                     cwd=excluded.cwd,
                     title=excluded.title,
                     manual=excluded.manual,
                     updated_at=excluded.updated_at",
                params![
                    workspace.id,
                    body,
                    workspace.cwd,
                    workspace.title,
                    if workspace.manual { 1 } else { 0 },
                    now()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn remove_workspace(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM host_workspaces WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn save_session(&self, session: &SessionBinding) -> Result<(), String> {
        let body = serde_json::to_string(session).map_err(|e| e.to_string())?;
        self.connection
            .execute(
                "INSERT INTO host_sessions(id, body, workspace_id, harness_id, title, pinned, archived, imported, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     body=excluded.body,
                     workspace_id=excluded.workspace_id,
                     harness_id=excluded.harness_id,
                     title=excluded.title,
                     pinned=excluded.pinned,
                     archived=excluded.archived,
                     imported=excluded.imported,
                     updated_at=excluded.updated_at",
                params![
                    session.id,
                    body,
                    session.workspace_id,
                    session.harness_id,
                    session.title,
                    if session.pinned { 1 } else { 0 },
                    if session.archived { 1 } else { 0 },
                    if session.imported { 1 } else { 0 },
                    session.updated_at as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn remove_session(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM host_sessions WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn preference(&self, key: &str) -> Option<Value> {
        self.connection
            .query_row(
                "SELECT body FROM host_preferences WHERE key=?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
    }
    pub fn set_preference(&self, key: &str, value: &Value) -> Result<(), String> {
        self.connection.execute("INSERT INTO host_preferences VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET body=excluded.body", params![key, value.to_string()]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn devices(&self) -> Result<Vec<Value>, String> {
        let mut s = self
            .connection
            .prepare("SELECT id,name,paired_at,revoked FROM host_devices ORDER BY paired_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = s.query_map([], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"pairedAt":r.get::<_,u64>(2)?,"revoked":r.get::<_,bool>(3)?}))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn add_device(&self, id: &str, name: &str, hash: &str) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO host_devices(id,name,token_hash,paired_at) VALUES (?1,?2,?3,?4)",
                params![id, name, hash, now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn authorize_device(&self, hash: &str) -> Option<String> {
        self.connection
            .query_row(
                "SELECT id FROM host_devices WHERE token_hash=?1 AND revoked=0",
                [hash],
                |r| r.get(0),
            )
            .ok()
    }
    pub fn device_active(&self, id: &str) -> bool {
        self.connection
            .query_row(
                "SELECT revoked=0 FROM host_devices WHERE id=?1",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
    }
    pub fn revoke_device(&self, id: &str) -> Result<(), String> {
        self.connection
            .execute("UPDATE host_devices SET revoked=1 WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn canonical_workspace(path: &str) -> Result<PathBuf, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("工作目录路径为空".into());
    }
    let resolved =
        std::fs::canonicalize(raw).map_err(|e| format!("无法访问工作目录 {raw}：{e}"))?;
    if !resolved.is_dir() {
        return Err(format!("工作目录必须是文件夹：{raw}"));
    }
    Ok(resolved)
}
pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        value.trim_start_matches(r"\\?\").replace('\\', "/")
    }
}
pub fn stable_id(kind: &str, value: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_string()
    };
    let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    format!("{kind}-{}", &hash[..24])
}
