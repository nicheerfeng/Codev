//! Unified Codev SQLite store (`codev.sqlite3`) for notepad, UI state cache, and shell history.
//! Includes redundant readable keys/columns alongside primary keys for durability and direct inspection.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn infer_ui_category(key: &str) -> String {
    let trimmed = key.strip_prefix("codev.").unwrap_or(key);
    let head = trimmed.split(['.', ':']).next().unwrap_or("general");
    if head.is_empty() {
        "general".into()
    } else {
        head.chars().take(48).collect()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteItemRecord {
    pub id: String,
    pub text: String,
    pub done: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub done_at: Option<i64>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteProjectRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub done_collapsed: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub items: Vec<NoteItemRecord>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotePadPayload {
    pub projects: Vec<NoteProjectRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellHistoryRow {
    pub shell: String,
    pub cwd: String,
    pub command: String,
    pub hit_count: i64,
    pub last_used_at: i64,
}

pub struct AppDb {
    connection: Connection,
    data_dir: PathBuf,
}

impl AppDb {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(directory.join("codev.sqlite3")).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS notepad_projects(
                     id TEXT PRIMARY KEY,
                     name TEXT NOT NULL,
                     locked INTEGER NOT NULL DEFAULT 0,
                     collapsed INTEGER NOT NULL DEFAULT 0,
                     done_collapsed INTEGER NOT NULL DEFAULT 1,
                     sort_order INTEGER NOT NULL DEFAULT 0,
                     created_at INTEGER NOT NULL DEFAULT 0,
                     updated_at INTEGER NOT NULL DEFAULT 0,
                     deleted_at INTEGER DEFAULT NULL
                 );
                 CREATE TABLE IF NOT EXISTS notepad_items(
                     id TEXT PRIMARY KEY,
                     project_id TEXT NOT NULL,
                     project_name TEXT NOT NULL,
                     text TEXT NOT NULL,
                     done INTEGER NOT NULL DEFAULT 0,
                     sort_order INTEGER NOT NULL DEFAULT 0,
                     created_at INTEGER NOT NULL DEFAULT 0,
                     updated_at INTEGER NOT NULL DEFAULT 0,
                     done_at INTEGER DEFAULT NULL,
                     deleted_at INTEGER DEFAULT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_notepad_items_proj
                     ON notepad_items(project_id, sort_order);
                 CREATE TABLE IF NOT EXISTS ui_state_kv(
                     key TEXT PRIMARY KEY,
                     value TEXT NOT NULL,
                     category TEXT NOT NULL,
                     value_len INTEGER NOT NULL DEFAULT 0,
                     updated_at INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX IF NOT EXISTS idx_ui_state_category
                     ON ui_state_kv(category);
                 CREATE TABLE IF NOT EXISTS shell_history_entries(
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     shell TEXT NOT NULL DEFAULT 'default',
                     cwd TEXT NOT NULL DEFAULT '',
                     command TEXT NOT NULL,
                     cmd_lower TEXT NOT NULL,
                     hit_count INTEGER NOT NULL DEFAULT 1,
                     last_used_at INTEGER NOT NULL DEFAULT 0,
                     UNIQUE(shell, command)
                 );
                 CREATE INDEX IF NOT EXISTS idx_shell_history_recent
                     ON shell_history_entries(last_used_at DESC);
                 CREATE TABLE IF NOT EXISTS app_cache_meta(
                     meta_key TEXT PRIMARY KEY,
                     meta_value TEXT NOT NULL,
                     updated_at INTEGER NOT NULL DEFAULT 0
                 );
                 PRAGMA user_version=2;",
            )
            .map_err(|e| e.to_string())?;
        Self::ensure_notepad_columns(&connection)?;
        Ok(Self {
            connection,
            data_dir: directory.to_path_buf(),
        })
    }

    fn ensure_column(
        connection: &Connection,
        table: &str,
        column: &str,
        definition: &str,
    ) -> Result<(), String> {
        let mut stmt = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let exists = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .any(|name| name == column);
        if !exists {
            connection
                .execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn ensure_notepad_columns(connection: &Connection) -> Result<(), String> {
        Self::ensure_column(connection, "notepad_projects", "collapsed", "INTEGER NOT NULL DEFAULT 0")?;
        Self::ensure_column(connection, "notepad_projects", "done_collapsed", "INTEGER NOT NULL DEFAULT 1")?;
        Self::ensure_column(connection, "notepad_projects", "created_at", "INTEGER NOT NULL DEFAULT 0")?;
        Self::ensure_column(connection, "notepad_projects", "deleted_at", "INTEGER DEFAULT NULL")?;
        Self::ensure_column(connection, "notepad_items", "created_at", "INTEGER NOT NULL DEFAULT 0")?;
        Self::ensure_column(connection, "notepad_items", "done_at", "INTEGER DEFAULT NULL")?;
        Self::ensure_column(connection, "notepad_items", "deleted_at", "INTEGER DEFAULT NULL")?;
        Ok(())
    }

    fn meta(&self, key: &str) -> Option<String> {
        self.connection
            .query_row(
                "SELECT meta_value FROM app_cache_meta WHERE meta_key=?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .ok()
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO app_cache_meta(meta_key, meta_value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at",
                params![key, value, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_notepad(&mut self) -> Result<NotePadPayload, String> {
        self.maybe_migrate_legacy_notepad()?;
        let mut proj_stmt = self
            .connection
            .prepare(
                "SELECT id, name, locked, collapsed, done_collapsed, created_at, updated_at, deleted_at
                 FROM notepad_projects ORDER BY sort_order ASC",
            )
            .map_err(|e| e.to_string())?;
        let mut projects: Vec<NoteProjectRecord> = proj_stmt
            .query_map([], |r| {
                Ok(NoteProjectRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    locked: r.get::<_, i64>(2)? != 0,
                    collapsed: r.get::<_, i64>(3)? != 0,
                    done_collapsed: r.get::<_, i64>(4)? != 0,
                    created_at: r.get::<_, i64>(5)?,
                    updated_at: r.get::<_, i64>(6)?,
                    deleted_at: r.get::<_, Option<i64>>(7)?,
                    items: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        if !projects.is_empty() {
            let mut item_stmt = self
                .connection
                .prepare(
                    "SELECT id, project_id, text, done, created_at, updated_at, done_at, deleted_at
                     FROM notepad_items ORDER BY sort_order ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = item_stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(1)?,
                        NoteItemRecord {
                            id: r.get(0)?,
                            text: r.get(2)?,
                            done: r.get::<_, i64>(3)? != 0,
                            created_at: r.get::<_, i64>(4)?,
                            updated_at: r.get::<_, i64>(5)?,
                            done_at: r.get::<_, Option<i64>>(6)?,
                            deleted_at: r.get::<_, Option<i64>>(7)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut by_project: HashMap<String, Vec<NoteItemRecord>> = HashMap::new();
            for (project_id, item) in rows {
                by_project.entry(project_id).or_default().push(item);
            }
            for project in &mut projects {
                if let Some(items) = by_project.remove(&project.id) {
                    project.items = items;
                }
            }
        }
        Ok(NotePadPayload { projects })
    }

    pub fn save_notepad(&mut self, pad: &NotePadPayload) -> Result<(), String> {
        let ts = now_ms();
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        let mut keep_project_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut keep_item_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for (p_idx, project) in pad.projects.iter().enumerate() {
            keep_project_ids.insert(project.id.clone());
            let created_at = if project.created_at > 0 {
                project.created_at
            } else {
                ts
            };
            let updated_at = if project.updated_at > 0 {
                project.updated_at
            } else {
                ts
            };
            tx.execute(
                "INSERT INTO notepad_projects(
                     id, name, locked, collapsed, done_collapsed, sort_order, created_at, updated_at, deleted_at
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name,
                     locked=excluded.locked,
                     collapsed=excluded.collapsed,
                     done_collapsed=excluded.done_collapsed,
                     sort_order=excluded.sort_order,
                     updated_at=excluded.updated_at,
                     deleted_at=excluded.deleted_at",
                params![
                    project.id,
                    project.name,
                    if project.locked { 1 } else { 0 },
                    if project.collapsed { 1 } else { 0 },
                    if project.done_collapsed { 1 } else { 0 },
                    p_idx as i64,
                    created_at,
                    updated_at,
                    project.deleted_at
                ],
            )
            .map_err(|e| e.to_string())?;

            for (i_idx, item) in project.items.iter().enumerate() {
                keep_item_ids.insert(item.id.clone());
                let item_created = if item.created_at > 0 {
                    item.created_at
                } else {
                    ts
                };
                let item_updated = if item.updated_at > 0 {
                    item.updated_at
                } else {
                    ts
                };
                tx.execute(
                    "INSERT INTO notepad_items(
                         id, project_id, project_name, text, done, sort_order, created_at, updated_at, done_at, deleted_at
                     )
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET
                         project_id=excluded.project_id,
                         project_name=excluded.project_name,
                         text=excluded.text,
                         done=excluded.done,
                         sort_order=excluded.sort_order,
                         updated_at=excluded.updated_at,
                         done_at=excluded.done_at,
                         deleted_at=excluded.deleted_at",
                    params![
                        item.id,
                        project.id,
                        project.name,
                        item.text,
                        if item.done { 1 } else { 0 },
                        i_idx as i64,
                        item_created,
                        item_updated,
                        item.done_at,
                        item.deleted_at
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Remove only records explicitly purged from the payload (e.g., emptying trash).
        let existing_items: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM notepad_items")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        for id in existing_items {
            if !keep_item_ids.contains(&id) {
                tx.execute("DELETE FROM notepad_items WHERE id=?1", [id])
                    .map_err(|e| e.to_string())?;
            }
        }

        let existing_projects: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT id FROM notepad_projects")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        for id in existing_projects {
            if !keep_project_ids.contains(&id) {
                tx.execute("DELETE FROM notepad_projects WHERE id=?1", [id])
                    .map_err(|e| e.to_string())?;
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn maybe_migrate_legacy_notepad(&mut self) -> Result<(), String> {
        if self.meta("legacy_notepad_imported").is_some() {
            return Ok(());
        }
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM notepad_projects", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 {
            self.set_meta("legacy_notepad_imported", "skipped_existing")?;
            return Ok(());
        }
        let legacy_path = self.data_dir.join("codev-notepad.json");
        if let Ok(raw) = std::fs::read_to_string(&legacy_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                let candidate = val.get("notepad").cloned().unwrap_or(val);
                if let Ok(pad) = serde_json::from_value::<NotePadPayload>(candidate) {
                    if !pad.projects.is_empty() {
                        self.save_notepad(&pad)?;
                    }
                }
            }
        }
        self.set_meta("legacy_notepad_imported", "done")?;
        Ok(())
    }

    pub fn load_ui_all(&mut self) -> Result<HashMap<String, String>, String> {
        self.maybe_migrate_legacy_ui_state()?;
        let mut stmt = self
            .connection
            .prepare("SELECT key, value FROM ui_state_kv")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            out.insert(k, v);
        }
        Ok(out)
    }

    pub fn set_ui(&self, key: &str, value: &str) -> Result<(), String> {
        let category = infer_ui_category(key);
        let value_len = value.len() as i64;
        self.connection
            .execute(
                "INSERT INTO ui_state_kv(key, value, category, value_len, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(key) DO UPDATE SET
                     value=excluded.value,
                     category=excluded.category,
                     value_len=excluded.value_len,
                     updated_at=excluded.updated_at",
                params![key, value, category, value_len, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn maybe_migrate_legacy_ui_state(&mut self) -> Result<(), String> {
        if self.meta("legacy_ui_state_imported").is_some() {
            return Ok(());
        }
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM ui_state_kv", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 {
            self.set_meta("legacy_ui_state_imported", "skipped_existing")?;
            return Ok(());
        }
        let legacy_path = self.data_dir.join("codev-ui-state.json");
        if let Ok(raw) = std::fs::read_to_string(&legacy_path) {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) {
                for (k, v) in map {
                    if let Some(s) = v.as_str() {
                        let _ = self.set_ui(&k, s);
                    }
                }
            }
        }
        self.set_meta("legacy_ui_state_imported", "done")?;
        Ok(())
    }

    pub fn record_shell_command(&self, shell: &str, cwd: &str, command: &str) -> Result<(), String> {
        let cmd = command.trim();
        if cmd.is_empty() {
            return Ok(());
        }
        let shell_key = if shell.trim().is_empty() {
            "default"
        } else {
            shell.trim()
        };
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.connection
            .execute(
                "INSERT INTO shell_history_entries(shell, cwd, command, cmd_lower, hit_count, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)
                 ON CONFLICT(shell, command) DO UPDATE SET
                     cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE shell_history_entries.cwd END,
                     hit_count = shell_history_entries.hit_count + 1,
                     last_used_at = MAX(shell_history_entries.last_used_at, excluded.last_used_at)",
                params![shell_key, cwd.trim(), cmd, cmd.to_lowercase(), ts],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_shell_commands(&self, limit: usize) -> Result<Vec<ShellHistoryRow>, String> {
        let mut stmt = self
            .connection
            .prepare(
                "SELECT shell, cwd, command, hit_count, last_used_at
                 FROM shell_history_entries
                 ORDER BY last_used_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(ShellHistoryRow {
                    shell: r.get(0)?,
                    cwd: r.get(1)?,
                    command: r.get(2)?,
                    hit_count: r.get(3)?,
                    last_used_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[derive(Default)]
pub struct AppDbState {
    inner: Mutex<Option<AppDb>>,
}

impl AppDbState {
    pub fn init_dir(&self, dir: &Path) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(AppDb::open(dir)?);
        }
        Ok(())
    }

    pub fn with_db<T>(&self, app: &AppHandle, f: impl FnOnce(&mut AppDb) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            *guard = Some(AppDb::open(&dir)?);
        }
        let db = guard.as_mut().ok_or("数据库未初始化")?;
        f(db)
    }

    pub fn with_opened_db<T>(&self, f: impl FnOnce(&mut AppDb) -> Result<T, String>) -> Option<T> {
        let mut guard = self.inner.lock().ok()?;
        let db = guard.as_mut()?;
        f(db).ok()
    }
}

#[tauri::command]
pub fn app_db_notepad_load(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
) -> Result<Value, String> {
    let payload = state.with_db(&app, |db| db.load_notepad())?;
    Ok(json!(payload))
}

#[tauri::command]
pub fn app_db_notepad_save(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    pad: NotePadPayload,
) -> Result<(), String> {
    state.with_db(&app, |db| db.save_notepad(&pad))
}

#[tauri::command]
pub fn app_db_ui_load_all(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
) -> Result<HashMap<String, String>, String> {
    state.with_db(&app, |db| db.load_ui_all())
}

#[tauri::command]
pub fn app_db_ui_set(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.with_db(&app, |db| db.set_ui(&key, &value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn notepad_and_ui_migrate_legacy_json_with_redundant_keys() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("codev-notepad.json"),
            serde_json::to_string(&json!({
                "notepad": {
                    "projects": [
                        {
                            "id": "tmp",
                            "name": "临时记录",
                            "locked": true,
                            "items": [{"id": "n1", "text": "查日志", "done": false}]
                        },
                        {
                            "id": "p2",
                            "name": "Codev",
                            "items": [{"id": "n2", "text": "SQLite 持久化", "done": true}]
                        }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("codev-ui-state.json"),
            serde_json::to_string(&json!({
                "codev.sidebar.width": "320",
                "codev.dock.order": "[\"pi\",\"terminal\"]"
            }))
            .unwrap(),
        )
        .unwrap();

        let mut db = AppDb::open(dir.path()).unwrap();
        let pad = db.load_notepad().unwrap();
        assert_eq!(pad.projects.len(), 2);
        assert_eq!(pad.projects[0].name, "临时记录");
        assert!(pad.projects[0].locked);
        assert_eq!(pad.projects[1].items[0].text, "SQLite 持久化");

        // Verify redundant project_name column stored cleanly
        let redundant_name: String = db
            .connection
            .query_row(
                "SELECT project_name FROM notepad_items WHERE id='n2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(redundant_name, "Codev");

        let ui = db.load_ui_all().unwrap();
        assert_eq!(ui.get("codev.sidebar.width").map(String::as_str), Some("320"));
        let cat: String = db
            .connection
            .query_row(
                "SELECT category FROM ui_state_kv WHERE key='codev.dock.order'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cat, "dock");

        db.record_shell_command("pwsh", "D:/repo", "pnpm test").unwrap();
        db.record_shell_command("pwsh", "D:/repo", "pnpm test").unwrap();
        let hist = db.load_shell_commands(10).unwrap();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].hit_count, 2);
    }
}
