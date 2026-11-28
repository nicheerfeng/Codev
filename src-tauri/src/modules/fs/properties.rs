use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// 控制进行中的目录属性递归统计，关闭弹窗或发起新统计时立即取消旧扫描。
#[derive(Default)]
pub struct PropertiesScanState {
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPropertiesInitial {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub kind: String,
    pub size: u64,
    pub readonly: bool,
    pub created_at: Option<u64>,
    pub modified_at: Option<u64>,
    pub accessed_at: Option<u64>,
    pub link_target: Option<String>,
    pub needs_scan: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPropertiesProgress {
    pub request_id: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub skipped_count: u64,
    pub done: bool,
    pub cancelled: bool,
}

fn time_to_ms(value: std::io::Result<SystemTime>) -> Option<u64> {
    value
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// 立即返回文件或目录的基础元数据（不遍历子目录），大文件夹不会阻塞主线程。
#[tauri::command]
pub fn fs_properties_inspect(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<PathPropertiesInitial, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let sym_meta = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    let is_symlink = sym_meta.file_type().is_symlink();
    let meta = std::fs::metadata(&p).unwrap_or_else(|_| sym_meta.clone());
    let link_target = if is_symlink {
        std::fs::read_link(&p).ok().map(super::to_canon)
    } else {
        None
    };

    let kind = if is_symlink {
        if meta.is_dir() {
            "symlink-dir"
        } else {
            "symlink-file"
        }
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    }
    .to_string();

    let canon = super::to_canon(&p);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| canon.clone());
    let parent = p.parent().map(super::to_canon).unwrap_or_default();

    Ok(PathPropertiesInitial {
        path: canon,
        name,
        parent,
        kind,
        size: if meta.is_dir() { 0 } else { meta.len() },
        readonly: meta.permissions().readonly(),
        created_at: time_to_ms(meta.created()),
        modified_at: time_to_ms(meta.modified()),
        accessed_at: time_to_ms(meta.accessed()),
        link_target,
        needs_scan: meta.is_dir() && !is_symlink,
    })
}

/// 在后台线程迭代遍历目录并按节流频率持续推送累加统计，不递归跟随符号链接，支持随时取消。
#[tauri::command]
pub fn fs_properties_scan_start(
    request_id: String,
    path: String,
    workspace: Option<WorkspaceEnv>,
    state: State<'_, PropertiesScanState>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&path, &workspace);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut tasks) = state.tasks.lock() {
        if let Some(prev) = tasks.insert(request_id.clone(), cancel.clone()) {
            prev.store(true, Ordering::Relaxed);
        }
    }

    let req = request_id.clone();
    std::thread::spawn(move || {
        let mut stack: Vec<PathBuf> = vec![root];
        let mut total_bytes: u64 = 0;
        let mut file_count: u64 = 0;
        let mut dir_count: u64 = 0;
        let mut skipped_count: u64 = 0;
        let mut last_emit = Instant::now();
        let emit_interval = Duration::from_millis(90);

        while let Some(dir) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "fs:properties-progress",
                    PathPropertiesProgress {
                        request_id: req,
                        total_bytes,
                        file_count,
                        dir_count,
                        skipped_count,
                        done: true,
                        cancelled: true,
                    },
                );
                return;
            }

            let entries = match std::fs::read_dir(&dir) {
                Ok(iter) => iter,
                Err(_) => {
                    skipped_count += 1;
                    continue;
                }
            };

            for entry_res in entries {
                if cancel.load(Ordering::Relaxed) {
                    let _ = app.emit(
                        "fs:properties-progress",
                        PathPropertiesProgress {
                            request_id: req,
                            total_bytes,
                            file_count,
                            dir_count,
                            skipped_count,
                            done: true,
                            cancelled: true,
                        },
                    );
                    return;
                }
                let Ok(entry) = entry_res else {
                    skipped_count += 1;
                    continue;
                };
                let entry_path = entry.path();
                let Ok(ft) = entry.file_type() else {
                    skipped_count += 1;
                    continue;
                };
                if ft.is_symlink() {
                    file_count += 1;
                    continue;
                }
                if ft.is_dir() {
                    dir_count += 1;
                    stack.push(entry_path);
                } else {
                    file_count += 1;
                    if let Ok(meta) = entry.metadata() {
                        total_bytes = total_bytes.saturating_add(meta.len());
                    }
                }

                if last_emit.elapsed() >= emit_interval {
                    last_emit = Instant::now();
                    let _ = app.emit(
                        "fs:properties-progress",
                        PathPropertiesProgress {
                            request_id: req.clone(),
                            total_bytes,
                            file_count,
                            dir_count,
                            skipped_count,
                            done: false,
                            cancelled: false,
                        },
                    );
                }
            }
        }

        let _ = app.emit(
            "fs:properties-progress",
            PathPropertiesProgress {
                request_id: req,
                total_bytes,
                file_count,
                dir_count,
                skipped_count,
                done: true,
                cancelled: false,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn fs_properties_scan_cancel(
    request_id: String,
    state: State<'_, PropertiesScanState>,
) -> Result<(), String> {
    if let Ok(mut tasks) = state.tasks.lock() {
        if let Some(flag) = tasks.remove(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
