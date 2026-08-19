use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

use super::to_canon;

const EVENT_NAME: &str = "fs:transfer";
const COPY_BUFFER_SIZE: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 文件迁移类型，复制保留源文件，移动完成后删除源文件。
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}

impl TransferMode {
    /// 返回前端展示用的迁移类型名称。
    fn label(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub id: u64,
    pub mode: String,
    pub status: String,
    pub current_path: Option<String>,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_items: u64,
    pub total_items: u64,
    pub error: Option<TransferError>,
    pub can_undo: bool,
}

struct Operation {
    cancel: AtomicBool,
    undo: Mutex<Option<UndoRecord>>,
}

#[derive(Default)]
pub struct TransferState {
    next_id: AtomicU64,
    operations: Arc<Mutex<HashMap<u64, Arc<Operation>>>>,
}

#[derive(Clone)]
struct TransferItem {
    source: PathBuf,
    target: PathBuf,
    bytes: u64,
    items: u64,
    same_volume: bool,
}

#[derive(Clone)]
struct UndoEntry {
    source: PathBuf,
    target: PathBuf,
    mode: TransferMode,
    same_volume: bool,
    target_size: u64,
    target_mtime: u64,
}

#[derive(Clone)]
struct UndoRecord {
    entries: Vec<UndoEntry>,
}

struct TransferFailure {
    error: TransferError,
    cancelled: bool,
}

struct Progress<'a> {
    app: &'a AppHandle,
    id: u64,
    mode: String,
    total_bytes: u64,
    total_items: u64,
    done_bytes: u64,
    done_items: u64,
    last_emit: Instant,
}

struct StagingGuard(Option<PathBuf>);

impl StagingGuard {
    /// 创建一个在任务结束时清理的临时迁移目录守卫。
    fn new(path: Option<PathBuf>) -> Self {
        Self(path)
    }
}

impl Drop for StagingGuard {
    /// 清理未提交的临时文件，避免取消任务留下半成品目录。
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// 启动后台文件迁移任务并立即返回任务 id。
#[tauri::command]
pub fn fs_transfer_start(
    sources: Vec<String>,
    dest_dir: String,
    mode: TransferMode,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
    state: State<'_, TransferState>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let operation = Arc::new(Operation {
        cancel: AtomicBool::new(false),
        undo: Mutex::new(None),
    });
    state
        .operations
        .lock()
        .map_err(|_| "transfer state is unavailable".to_string())?
        .insert(id, Arc::clone(&operation));

    let operations = Arc::clone(&state.operations);
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_transfer(
            id,
            sources,
            dest_dir,
            mode,
            WorkspaceEnv::from_option(workspace),
            &app,
            &operation,
        );
        finish_operation(id, mode.label(), result, &app, &operation);
        if let Ok(mut all) = operations.lock() {
            if all.len() > 24 {
                if let Some(oldest) = all.keys().copied().min() {
                    all.remove(&oldest);
                }
            }
        }
    });

    Ok(id)
}

/// 请求后台迁移在安全检查点停止。
#[tauri::command]
pub fn fs_transfer_cancel(id: u64, state: State<'_, TransferState>) -> Result<(), String> {
    let operations = state
        .operations
        .lock()
        .map_err(|_| "transfer state is unavailable".to_string())?;
    let operation = operations
        .get(&id)
        .ok_or_else(|| "transfer task not found".to_string())?;
    operation.cancel.store(true, Ordering::Release);
    Ok(())
}

/// 为已完成的复制或移动任务启动异步撤销任务。
#[tauri::command]
pub fn fs_transfer_undo(
    id: u64,
    app: AppHandle,
    state: State<'_, TransferState>,
) -> Result<u64, String> {
    let record = state
        .operations
        .lock()
        .map_err(|_| "transfer state is unavailable".to_string())?
        .get(&id)
        .and_then(|operation| operation.undo.lock().ok()?.clone())
        .ok_or_else(|| "transfer cannot be undone".to_string())?;

    let undo_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let operation = Arc::new(Operation {
        cancel: AtomicBool::new(false),
        undo: Mutex::new(None),
    });
    state
        .operations
        .lock()
        .map_err(|_| "transfer state is unavailable".to_string())?
        .insert(undo_id, Arc::clone(&operation));

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_undo(undo_id, record, &app, &operation);
        finish_operation(undo_id, "undo", result, &app, &operation);
    });

    Ok(undo_id)
}

/// 执行迁移主流程，跨磁盘移动自动退化为复制后删除。
fn run_transfer(
    id: u64,
    sources: Vec<String>,
    dest_dir: String,
    mode: TransferMode,
    workspace: WorkspaceEnv,
    app: &AppHandle,
    operation: &Operation,
) -> Result<UndoRecord, TransferFailure> {
    let destination = resolve_path(&dest_dir, &workspace);
    if !destination.is_dir() {
        return Err(failure(
            "target_not_directory",
            destination,
            "目标位置不是文件夹".to_string(),
        ));
    }

    emit_event(
        app,
        id,
        mode.label(),
        "preparing",
        None,
        0,
        0,
        0,
        0,
        None,
        false,
    );

    let mut seen_targets = HashSet::new();
    let mut plan = Vec::new();
    for raw in sources {
        check_cancel(operation, PathBuf::from(&raw))?;
        let source = resolve_path(&raw, &workspace);
        let name = source
            .file_name()
            .ok_or_else(|| failure("invalid_source", source.clone(), "源路径无效".to_string()))?;
        let target = destination.join(name);
        let target_key = target.to_string_lossy().to_lowercase();
        if !seen_targets.insert(target_key) || target.exists() {
            return Err(failure(
                "target_exists",
                target,
                "目标位置已存在同名文件或文件夹".to_string(),
            ));
        }
        if is_inside(&target, &source) || source == target {
            return Err(failure(
                "recursive_target",
                source,
                "不能将文件夹迁移到自身或其子目录".to_string(),
            ));
        }
        let stats = scan_tree(&source, operation)?;
        let same_volume = same_volume(&source, &destination);
        plan.push(TransferItem {
            source,
            target,
            bytes: stats.bytes,
            items: stats.items,
            same_volume,
        });
    }

    if plan.is_empty() {
        return Err(failure(
            "empty_sources",
            destination,
            "没有可迁移的项目".to_string(),
        ));
    }

    let total_bytes = plan.iter().map(|item| item.bytes).sum();
    let total_items = plan.iter().map(|item| item.items).sum();
    let mut progress = Progress {
        app,
        id,
        mode: mode.label().to_string(),
        total_bytes,
        total_items,
        done_bytes: 0,
        done_items: 0,
        last_emit: Instant::now() - PROGRESS_INTERVAL,
    };
    let mut undo_entries = Vec::new();
    let staging = destination.join(format!(".terax-transfer-{id}"));
    let needs_staging = plan
        .iter()
        .any(|item| matches!(mode, TransferMode::Copy) || !item.same_volume);
    let _staging_guard = StagingGuard::new(needs_staging.then(|| staging.clone()));
    if needs_staging {
        fs::create_dir(&staging).map_err(|error| io_failure(&staging, error))?;
    }

    for item in plan {
        check_cancel(operation, item.source.clone())?;
        emit_progress(&mut progress, "running", Some(&item.source), false, None);
        let committed = if matches!(mode, TransferMode::Move) && item.same_volume {
            fs::rename(&item.source, &item.target)
                .map_err(|error| io_failure(&item.source, error))?;
            true
        } else {
            let staged = staging.join(item.target.file_name().unwrap_or_default());
            copy_tree(&item.source, &staged, operation, &mut progress)?;
            fs::rename(&staged, &item.target).map_err(|error| io_failure(&item.target, error))?;
            if matches!(mode, TransferMode::Move) {
                remove_tree(&item.source, None, &mut progress)?;
            }
            true
        };

        if committed {
            let target_meta =
                fs::metadata(&item.target).map_err(|error| io_failure(&item.target, error))?;
            undo_entries.push(UndoEntry {
                source: item.source,
                target: item.target.clone(),
                mode,
                same_volume: item.same_volume,
                target_size: target_meta.len(),
                target_mtime: modified_millis(&target_meta),
            });
            if matches!(mode, TransferMode::Move) && item.same_volume {
                progress.done_bytes = progress.done_bytes.saturating_add(item.bytes);
            }
            progress.done_items = progress.done_items.saturating_add(item.items);
            emit_progress(&mut progress, "running", Some(&item.target), false, None);
        }
    }

    Ok(UndoRecord {
        entries: undo_entries,
    })
}

/// 执行复制或移动撤销并复用同一套进度事件。
fn run_undo(
    id: u64,
    record: UndoRecord,
    app: &AppHandle,
    operation: &Operation,
) -> Result<UndoRecord, TransferFailure> {
    let total_items = record.entries.len() as u64;
    emit_event(
        app,
        id,
        "undo",
        "preparing",
        None,
        0,
        0,
        0,
        total_items,
        None,
        false,
    );
    let total_bytes = record.entries.iter().map(|entry| entry.target_size).sum();
    let mut progress = Progress {
        app,
        id,
        mode: "undo".to_string(),
        total_bytes,
        total_items,
        done_bytes: 0,
        done_items: 0,
        last_emit: Instant::now() - PROGRESS_INTERVAL,
    };
    for entry in record.entries.iter().rev() {
        check_cancel(operation, entry.target.clone())?;
        match entry.mode {
            TransferMode::Copy => {
                ensure_unchanged(&entry.target, entry.target_size, entry.target_mtime)?;
                remove_tree(&entry.target, None, &mut progress)?;
            }
            TransferMode::Move => {
                if entry.source.exists() {
                    return Err(failure(
                        "undo_source_exists",
                        entry.source.clone(),
                        "源位置已有文件，无法安全撤销".to_string(),
                    ));
                }
                if entry.same_volume {
                    fs::rename(&entry.target, &entry.source)
                        .map_err(|error| io_failure(&entry.target, error))?;
                } else {
                    let parent = entry.source.parent().ok_or_else(|| {
                        failure(
                            "invalid_source",
                            entry.source.clone(),
                            "源路径没有父目录".to_string(),
                        )
                    })?;
                    let staging = parent.join(format!(".terax-undo-{id}"));
                    let _staging_guard = StagingGuard::new(Some(staging.clone()));
                    fs::create_dir(&staging).map_err(|error| io_failure(&staging, error))?;
                    let staged = staging.join(entry.source.file_name().unwrap_or_default());
                    copy_tree(&entry.target, &staged, operation, &mut progress)?;
                    fs::rename(&staged, &entry.source)
                        .map_err(|error| io_failure(&entry.source, error))?;
                    remove_tree(&entry.target, None, &mut progress)?;
                }
            }
        }
        if !matches!(entry.mode, TransferMode::Move) || entry.same_volume {
            progress.done_bytes = progress.done_bytes.saturating_add(entry.target_size);
        }
        progress.done_items += 1;
        emit_progress(&mut progress, "running", Some(&entry.source), false, None);
    }
    Ok(record)
}

/// 保存完成任务的撤销记录并发送最终状态。
fn finish_operation(
    id: u64,
    mode: &str,
    result: Result<UndoRecord, TransferFailure>,
    app: &AppHandle,
    operation: &Operation,
) {
    match result {
        Ok(record) => {
            let can_undo = mode != "undo" && !record.entries.is_empty();
            if let Ok(mut undo) = operation.undo.lock() {
                *undo = can_undo.then_some(record.clone());
            }
            emit_event(
                app,
                id,
                mode,
                "completed",
                None,
                0,
                0,
                record.entries.len() as u64,
                record.entries.len() as u64,
                None,
                can_undo,
            );
        }
        Err(failure) => {
            let failure_path = PathBuf::from(&failure.error.path);
            emit_event(
                app,
                id,
                mode,
                if failure.cancelled {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(failure_path.as_path()),
                0,
                0,
                0,
                0,
                Some(failure.error),
                false,
            );
        }
    }
}

/// 递归统计迁移总字节和项目数量，过程中响应取消信号。
fn scan_tree(path: &Path, operation: &Operation) -> Result<TreeStats, TransferFailure> {
    check_cancel(operation, path.to_path_buf())?;
    let meta = fs::symlink_metadata(path).map_err(|error| io_failure(path, error))?;
    if !meta.is_dir() {
        return Ok(TreeStats {
            bytes: meta.len(),
            items: 1,
        });
    }
    let mut stats = TreeStats { bytes: 0, items: 1 };
    for entry in fs::read_dir(path).map_err(|error| io_failure(path, error))? {
        let entry = entry.map_err(|error| io_failure(path, error))?;
        let child = scan_tree(&entry.path(), operation)?;
        stats.bytes = stats.bytes.saturating_add(child.bytes);
        stats.items = stats.items.saturating_add(child.items);
    }
    Ok(stats)
}

#[derive(Default)]
struct TreeStats {
    bytes: u64,
    items: u64,
}

/// 以分块读写复制文件，保证取消可在安全边界生效。
fn copy_tree(
    source: &Path,
    target: &Path,
    operation: &Operation,
    progress: &mut Progress<'_>,
) -> Result<(), TransferFailure> {
    check_cancel(operation, source.to_path_buf())?;
    let meta = fs::symlink_metadata(source).map_err(|error| io_failure(source, error))?;
    if meta.is_dir() {
        fs::create_dir(target).map_err(|error| io_failure(target, error))?;
        for entry in fs::read_dir(source).map_err(|error| io_failure(source, error))? {
            let entry = entry.map_err(|error| io_failure(source, error))?;
            copy_tree(
                &entry.path(),
                &target.join(entry.file_name()),
                operation,
                progress,
            )?;
        }
        return Ok(());
    }

    let mut input = File::open(source).map_err(|error| io_failure(source, error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| io_failure(target, error))?;
    let mut buffer = vec![0u8; COPY_BUFFER_SIZE];
    loop {
        check_cancel(operation, source.to_path_buf())?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| io_failure(source, error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| io_failure(target, error))?;
        progress.done_bytes = progress.done_bytes.saturating_add(read as u64);
        emit_progress(progress, "running", Some(source), false, None);
    }
    output
        .sync_all()
        .map_err(|error| io_failure(target, error))?;
    Ok(())
}

/// 递归删除已迁移源文件，并在每个条目之间检查取消请求。
fn remove_tree(
    path: &Path,
    operation: Option<&Operation>,
    progress: &mut Progress<'_>,
) -> Result<(), TransferFailure> {
    if let Some(operation) = operation {
        check_cancel(operation, path.to_path_buf())?;
    }
    let meta = fs::symlink_metadata(path).map_err(|error| io_failure(path, error))?;
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| io_failure(path, error))? {
            let entry = entry.map_err(|error| io_failure(path, error))?;
            remove_tree(&entry.path(), operation, progress)?;
        }
        fs::remove_dir(path).map_err(|error| io_failure(path, error))?;
    } else {
        fs::remove_file(path).map_err(|error| io_failure(path, error))?;
    }
    emit_progress(progress, "running", Some(path), false, None);
    Ok(())
}

/// 防止撤销操作误删用户在迁移后修改过的文件。
fn ensure_unchanged(
    path: &Path,
    expected_size: u64,
    expected_mtime: u64,
) -> Result<(), TransferFailure> {
    let meta = fs::metadata(path).map_err(|error| io_failure(path, error))?;
    if meta.len() != expected_size || modified_millis(&meta) != expected_mtime {
        return Err(failure(
            "changed_after_transfer",
            path.to_path_buf(),
            "目标文件在迁移后已被修改，无法安全撤销".to_string(),
        ));
    }
    Ok(())
}

/// 发送节流后的进度事件，避免大文件复制时刷新前端过密。
fn emit_progress(
    progress: &mut Progress<'_>,
    status: &str,
    current: Option<&Path>,
    can_undo: bool,
    error: Option<TransferError>,
) {
    if progress.last_emit.elapsed() < PROGRESS_INTERVAL && error.is_none() {
        return;
    }
    progress.last_emit = Instant::now();
    emit_event(
        progress.app,
        progress.id,
        &progress.mode,
        status,
        current,
        progress.done_bytes,
        progress.total_bytes,
        progress.done_items,
        progress.total_items,
        error,
        can_undo,
    );
}

/// 发送迁移状态事件给前端任务中心。
fn emit_event(
    app: &AppHandle,
    id: u64,
    mode: &str,
    status: &str,
    current: Option<&Path>,
    done_bytes: u64,
    total_bytes: u64,
    done_items: u64,
    total_items: u64,
    error: Option<TransferError>,
    can_undo: bool,
) {
    let _ = app.emit(
        EVENT_NAME,
        TransferEvent {
            id,
            mode: mode.to_string(),
            status: status.to_string(),
            current_path: current.map(to_canon),
            done_bytes,
            total_bytes,
            done_items,
            total_items,
            error,
            can_undo,
        },
    );
}

/// 检查任务是否收到停止请求，并生成可展示的取消错误。
fn check_cancel(operation: &Operation, path: PathBuf) -> Result<(), TransferFailure> {
    if operation.cancel.load(Ordering::Acquire) {
        return Err(TransferFailure {
            error: TransferError {
                code: "cancelled".to_string(),
                path: to_canon(path),
                message: "用户已停止迁移".to_string(),
            },
            cancelled: true,
        });
    }
    Ok(())
}

/// 将系统 IO 错误归类为前端可翻译的迁移错误。
fn io_failure(path: &Path, error: io::Error) -> TransferFailure {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::AlreadyExists => "target_exists",
        io::ErrorKind::StorageFull => "disk_full",
        _ if matches!(error.raw_os_error(), Some(32 | 33)) => "file_in_use",
        _ => "io_error",
    };
    failure(code, path.to_path_buf(), error.to_string())
}

/// 创建统一格式的迁移失败结果。
fn failure(code: &str, path: PathBuf, message: String) -> TransferFailure {
    TransferFailure {
        error: TransferError {
            code: code.to_string(),
            path: to_canon(path),
            message,
        },
        cancelled: false,
    }
}

/// 判断路径是否位于另一个目录之下。
fn is_inside(path: &Path, parent: &Path) -> bool {
    path != parent && path.strip_prefix(parent).is_ok()
}

/// 判断源路径和目标目录是否位于同一磁盘或文件系统。
fn same_volume(source: &Path, destination: &Path) -> bool {
    #[cfg(windows)]
    {
        let source = source.components().next();
        let destination = destination.components().next();
        return source == destination;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return fs::metadata(source).map(|m| m.dev()).ok()
            == fs::metadata(destination).map(|m| m.dev()).ok();
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (source, destination);
        true
    }
}

/// 返回文件修改时间的毫秒值，失败时回退为零。
fn modified_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
