use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const EVENT_NAME: &str = "fs:transfer-progress";
const BUFFER_SIZE: usize = 1024 * 1024;
const EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// 文件迁移类型。
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub id: String,
    pub status: String,
    pub error: Option<TransferError>,
    pub can_undo: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    id: String,
    phase: String,
    current_path: Option<String>,
    done_bytes: u64,
    total_bytes: u64,
}

struct ActiveTask {
    id: String,
    cancel: Arc<AtomicBool>,
    cancelable: bool,
}

#[derive(Clone)]
struct Item {
    source: PathBuf,
    target: PathBuf,
    same_volume: bool,
}

#[derive(Clone)]
struct UndoEntry {
    source: PathBuf,
    target: PathBuf,
    mode: TransferMode,
    same_volume: bool,
    size: u64,
    mtime: u64,
}

#[derive(Clone)]
struct UndoRecord {
    id: String,
    entries: Vec<UndoEntry>,
}

struct Progress<'a> {
    app: Option<&'a AppHandle>,
    id: &'a str,
    done: u64,
    total: u64,
    last_emit: Instant,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    /// 清理停止或失败任务的临时目录。
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
pub struct TransferState {
    active: Mutex<Option<ActiveTask>>,
    undo: Mutex<Option<UndoRecord>>,
}

/// 执行迁移并直接返回最终结果，进度事件不参与状态闭环。
#[tauri::command]
pub async fn fs_transfer_execute(
    id: String,
    sources: Vec<String>,
    dest_dir: String,
    mode: TransferMode,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
    state: State<'_, TransferState>,
) -> Result<TransferResult, String> {
    let cancel = begin(&state, &id, true)?;
    let worker_id = id.clone();
    let workspace = WorkspaceEnv::from_option(workspace);
    let job = tauri::async_runtime::spawn_blocking(move || {
        execute(
            &worker_id,
            sources,
            dest_dir,
            mode,
            workspace,
            Some(&app),
            &cancel,
        )
    })
    .await;
    end(&state, &id);

    match job {
        Ok(Ok(entries)) => {
            let can_undo = entries
                .iter()
                .all(|entry| matches!(entry.mode, TransferMode::Copy) || entry.same_volume);
            if let Ok(mut undo) = state.undo.lock() {
                *undo = can_undo.then(|| UndoRecord {
                    id: id.clone(),
                    entries,
                });
            }
            Ok(result(id, "completed", None, can_undo))
        }
        Ok(Err(error)) => Ok(error_result(id, error)),
        Err(error) => Ok(error_result(
            id,
            transfer_error("worker_failed", Path::new(""), error.to_string()),
        )),
    }
}

/// 请求当前复制或移动在提交前停止。
#[tauri::command]
pub fn fs_transfer_cancel(id: String, state: State<'_, TransferState>) -> Result<(), String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "迁移状态不可用".to_string())?;
    let task = active
        .as_ref()
        .filter(|task| task.id == id)
        .ok_or_else(|| "没有正在运行的迁移任务".to_string())?;
    if !task.cancelable {
        return Err("当前处于不可中断的提交阶段".to_string());
    }
    task.cancel.store(true, Ordering::Release);
    Ok(())
}

/// 撤销最近一次复制或同磁盘移动。
#[tauri::command]
pub async fn fs_transfer_undo(
    id: String,
    source_id: String,
    state: State<'_, TransferState>,
) -> Result<TransferResult, String> {
    let record = state
        .undo
        .lock()
        .map_err(|_| "撤销状态不可用".to_string())?
        .as_ref()
        .filter(|record| record.id == source_id)
        .cloned()
        .ok_or_else(|| "当前迁移无法撤销".to_string())?;
    begin(&state, &id, false)?;
    let job = tauri::async_runtime::spawn_blocking(move || undo(record)).await;
    end(&state, &id);

    match job {
        Ok(Ok(())) => {
            if let Ok(mut undo) = state.undo.lock() {
                *undo = None;
            }
            Ok(result(id, "completed", None, false))
        }
        Ok(Err(error)) => Ok(error_result(id, error)),
        Err(error) => Ok(error_result(
            id,
            transfer_error("worker_failed", Path::new(""), error.to_string()),
        )),
    }
}

/// 占用唯一任务槽并创建取消标记。
fn begin(state: &TransferState, id: &str, cancelable: bool) -> Result<Arc<AtomicBool>, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "迁移状态不可用".to_string())?;
    if active.is_some() {
        return Err("已有文件迁移正在进行".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveTask {
        id: id.to_string(),
        cancel: Arc::clone(&cancel),
        cancelable,
    });
    Ok(cancel)
}

/// 释放当前任务槽。
fn end(state: &TransferState, id: &str) {
    if let Ok(mut active) = state.active.lock() {
        if active.as_ref().is_some_and(|task| task.id == id) {
            *active = None;
        }
    }
}

/// 执行复制或移动的单条主链。
fn execute(
    id: &str,
    sources: Vec<String>,
    dest_dir: String,
    mode: TransferMode,
    workspace: WorkspaceEnv,
    app: Option<&AppHandle>,
    cancel: &AtomicBool,
) -> Result<Vec<UndoEntry>, TransferError> {
    let destination = resolve_path(&dest_dir, &workspace);
    if !destination.is_dir() {
        return Err(transfer_error(
            "target_not_directory",
            &destination,
            "目标位置不是文件夹".to_string(),
        ));
    }

    let mut names = HashSet::new();
    let mut items = Vec::new();
    let mut total = Some(0u64);
    for raw in sources {
        check_cancel(cancel, Path::new(&raw))?;
        let source = resolve_path(&raw, &workspace);
        let metadata = fs::symlink_metadata(&source).map_err(|error| io_error(&source, error))?;
        let name = source
            .file_name()
            .ok_or_else(|| transfer_error("invalid_source", &source, "源路径无效".to_string()))?;
        let target = allocate_target(&destination, name, mode, &mut names)?;
        if source == target || inside(&target, &source) {
            return Err(transfer_error(
                "recursive_target",
                &source,
                "不能迁移到自身或其子目录".to_string(),
            ));
        }
        total = if metadata.is_dir() {
            None
        } else {
            total.map(|value| value.saturating_add(metadata.len()))
        };
        items.push(Item {
            same_volume: same_volume(&source, &destination),
            source,
            target,
        });
    }
    if items.is_empty() {
        return Err(transfer_error(
            "empty_sources",
            &destination,
            "没有可迁移的项目".to_string(),
        ));
    }

    let mut progress = Progress {
        app,
        id,
        done: 0,
        total: total.unwrap_or(0),
        last_emit: Instant::now() - EMIT_INTERVAL,
    };
    if matches!(mode, TransferMode::Move) && items.iter().all(|item| item.same_volume) {
        check_cancel(cancel, &items[0].source)?;
        emit(&mut progress, "committing", None, true);
        rename_all(&items)?;
        return snapshots(items, mode);
    }

    let temp = destination.join(format!(".terax-transfer-{id}"));
    fs::create_dir(&temp).map_err(|error| io_error(&temp, error))?;
    let _guard = TempDir(temp.clone());
    emit(&mut progress, "copying", None, true);
    for item in &items {
        copy(
            &item.source,
            &temp.join(item.target.file_name().unwrap_or_default()),
            cancel,
            &mut progress,
        )?;
    }
    check_cancel(cancel, &items[0].source)?;
    emit(&mut progress, "committing", None, true);
    for item in &items {
        let staged = temp.join(item.target.file_name().unwrap_or_default());
        fs::rename(&staged, &item.target).map_err(|error| io_error(&item.target, error))?;
    }
    if matches!(mode, TransferMode::Move) {
        for item in &items {
            remove(&item.source).map_err(|error| io_error(&item.source, error))?;
        }
    }
    snapshots(items, mode)
}

/// 撤销复制或同磁盘移动。
fn undo(record: UndoRecord) -> Result<(), TransferError> {
    for entry in &record.entries {
        match entry.mode {
            TransferMode::Copy => check_snapshot(entry)?,
            TransferMode::Move => {
                if !entry.same_volume || entry.source.exists() || !entry.target.exists() {
                    return Err(transfer_error(
                        "undo_unavailable",
                        &entry.target,
                        "源位置已被占用或移动无法安全撤销".to_string(),
                    ));
                }
            }
        }
    }
    if matches!(record.entries[0].mode, TransferMode::Copy) {
        for entry in record.entries.iter().rev() {
            remove(&entry.target).map_err(|error| io_error(&entry.target, error))?;
        }
    } else {
        let items: Vec<Item> = record
            .entries
            .into_iter()
            .map(|entry| Item {
                source: entry.target,
                target: entry.source,
                same_volume: true,
            })
            .collect();
        rename_all(&items)?;
    }
    Ok(())
}

/// 为复制操作寻找不冲突的 `名称 (1)`、`名称 (2)` 目标名。
fn allocate_target(
    destination: &Path,
    name: &std::ffi::OsStr,
    mode: TransferMode,
    names: &mut HashSet<String>,
) -> Result<PathBuf, TransferError> {
    let original = destination.join(name);
    if matches!(mode, TransferMode::Move) {
        let key = original.to_string_lossy().to_lowercase();
        if original.exists() || !names.insert(key) {
            return Err(transfer_error(
                "target_exists",
                &original,
                "目标位置已存在同名文件或文件夹".to_string(),
            ));
        }
        return Ok(original);
    }

    let stem = Path::new(name).file_stem().unwrap_or(name);
    let extension = Path::new(name).extension();
    for index in 0u64.. {
        let candidate_name = if index == 0 {
            name.to_os_string()
        } else {
            let suffix = format!("{} ({index})", stem.to_string_lossy());
            let mut candidate = std::ffi::OsString::from(suffix);
            if let Some(extension) = extension {
                candidate.push(".");
                candidate.push(extension);
            }
            candidate
        };
        let candidate = destination.join(candidate_name);
        let key = candidate.to_string_lossy().to_lowercase();
        if !candidate.exists() && names.insert(key) {
            return Ok(candidate);
        }
    }
    unreachable!("copy name counter exhausted")
}

/// 批量重命名并在失败时恢复已提交条目。
fn rename_all(items: &[Item]) -> Result<(), TransferError> {
    let mut done: Vec<&Item> = Vec::new();
    for item in items {
        let (from, to) = (&item.source, &item.target);
        if let Err(error) = fs::rename(from, to) {
            for previous in done.into_iter().rev() {
                let _ = fs::rename(&previous.target, &previous.source);
            }
            return Err(io_error(from, error));
        }
        done.push(item);
    }
    Ok(())
}

/// 递归分块复制并在每个缓冲区边界检查停止标记。
fn copy(
    source: &Path,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress<'_>,
) -> Result<(), TransferError> {
    check_cancel(cancel, source)?;
    let metadata = fs::symlink_metadata(source).map_err(|error| io_error(source, error))?;
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|error| io_error(target, error))?;
        for entry in fs::read_dir(source).map_err(|error| io_error(source, error))? {
            let entry = entry.map_err(|error| io_error(source, error))?;
            copy(
                &entry.path(),
                &target.join(entry.file_name()),
                cancel,
                progress,
            )?;
        }
        return Ok(());
    }
    let mut input = File::open(source).map_err(|error| io_error(source, error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| io_error(target, error))?;
    let mut buffer = vec![0u8; BUFFER_SIZE];
    loop {
        check_cancel(cancel, source)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| io_error(source, error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| io_error(target, error))?;
        progress.done = progress.done.saturating_add(read as u64);
        emit(progress, "copying", Some(source), false);
    }
    output.sync_all().map_err(|error| io_error(target, error))
}

/// 保存撤销所需的目标快照。
fn snapshots(items: Vec<Item>, mode: TransferMode) -> Result<Vec<UndoEntry>, TransferError> {
    items
        .into_iter()
        .map(|item| {
            let metadata =
                fs::metadata(&item.target).map_err(|error| io_error(&item.target, error))?;
            Ok(UndoEntry {
                source: item.source,
                target: item.target,
                mode,
                same_volume: item.same_volume,
                size: metadata.len(),
                mtime: modified(&metadata),
            })
        })
        .collect()
}

/// 检查复制目标在撤销前是否被修改。
fn check_snapshot(entry: &UndoEntry) -> Result<(), TransferError> {
    let metadata = fs::metadata(&entry.target).map_err(|error| io_error(&entry.target, error))?;
    if metadata.len() != entry.size || modified(&metadata) != entry.mtime {
        return Err(transfer_error(
            "changed_after_transfer",
            &entry.target,
            "目标内容在迁移后已修改，无法安全撤销".to_string(),
        ));
    }
    Ok(())
}

/// 删除文件、符号链接或目录。
fn remove(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// 发送节流后的展示进度。
fn emit(progress: &mut Progress<'_>, phase: &str, current: Option<&Path>, force: bool) {
    if !force && progress.last_emit.elapsed() < EMIT_INTERVAL {
        return;
    }
    progress.last_emit = Instant::now();
    if let Some(app) = progress.app {
        let _ = app.emit(
            EVENT_NAME,
            TransferProgress {
                id: progress.id.to_string(),
                phase: phase.to_string(),
                current_path: current.map(to_canon),
                done_bytes: progress.done,
                total_bytes: progress.total,
            },
        );
    }
}

/// 检查任务是否收到停止请求。
fn check_cancel(cancel: &AtomicBool, path: &Path) -> Result<(), TransferError> {
    if cancel.load(Ordering::Acquire) {
        return Err(transfer_error(
            "cancelled",
            path,
            "用户已停止迁移".to_string(),
        ));
    }
    Ok(())
}

/// 转换系统 IO 错误。
fn io_error(path: &Path, error: io::Error) -> TransferError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::AlreadyExists => "target_exists",
        io::ErrorKind::StorageFull => "disk_full",
        _ if matches!(error.raw_os_error(), Some(32 | 33)) => "file_in_use",
        _ => "io_error",
    };
    transfer_error(code, path, error.to_string())
}

/// 创建统一迁移错误。
fn transfer_error(code: &str, path: &Path, message: String) -> TransferError {
    TransferError {
        code: code.to_string(),
        path: to_canon(path),
        message,
    }
}

/// 创建迁移最终结果。
fn result(
    id: String,
    status: &str,
    error: Option<TransferError>,
    can_undo: bool,
) -> TransferResult {
    TransferResult {
        id,
        status: status.to_string(),
        error,
        can_undo,
    }
}

/// 将失败转换为最终结果。
fn error_result(id: String, error: TransferError) -> TransferResult {
    let status = if error.code == "cancelled" {
        "cancelled"
    } else {
        "failed"
    };
    result(id, status, Some(error), false)
}

/// 判断路径是否位于另一个目录内部。
fn inside(path: &Path, parent: &Path) -> bool {
    path != parent && path.strip_prefix(parent).is_ok()
}

/// 判断两个路径是否位于同一磁盘。
fn same_volume(source: &Path, destination: &Path) -> bool {
    #[cfg(windows)]
    {
        return source.components().next() == destination.components().next();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return fs::metadata(source).map(|metadata| metadata.dev()).ok()
            == fs::metadata(destination)
                .map(|metadata| metadata.dev())
                .ok();
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (source, destination);
        true
    }
}

/// 返回文件修改时间毫秒值。
fn modified(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 转换测试路径。
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn tiny_copy_finishes_without_progress_listener() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("AGENTS.md");
        fs::write(&source, b"tiny").unwrap();

        let entries = execute(
            "tiny",
            vec![text(&source)],
            text(destination.path()),
            TransferMode::Copy,
            WorkspaceEnv::from_option(None),
            None,
            &AtomicBool::new(false),
        )
        .expect("tiny copy");

        assert_eq!(entries.len(), 1);
        assert_eq!(
            fs::read(destination.path().join("AGENTS.md")).unwrap(),
            b"tiny"
        );
    }

    #[test]
    fn existing_target_is_never_overwritten() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("same.txt");
        fs::write(&source, b"source").unwrap();
        fs::write(destination.path().join("same.txt"), b"keep").unwrap();

        let result = execute(
            "collision",
            vec![text(&source)],
            text(destination.path()),
            TransferMode::Move,
            WorkspaceEnv::from_option(None),
            None,
            &AtomicBool::new(false),
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("collision must fail"),
        };

        assert_eq!(error.code, "target_exists");
        assert_eq!(
            fs::read(destination.path().join("same.txt")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn same_directory_copy_allocates_numbered_name() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("note.md");
        fs::write(&source, b"note").unwrap();
        fs::write(directory.path().join("note (1).md"), b"old").unwrap();

        let entries = execute(
            "numbered-copy",
            vec![text(&source)],
            text(directory.path()),
            TransferMode::Copy,
            WorkspaceEnv::from_option(None),
            None,
            &AtomicBool::new(false),
        )
        .expect("numbered copy");

        assert_eq!(entries[0].target.file_name().unwrap(), "note (2).md");
        assert_eq!(
            fs::read(directory.path().join("note (2).md")).unwrap(),
            b"note"
        );
        assert_eq!(
            fs::read(directory.path().join("note (1).md")).unwrap(),
            b"old"
        );
    }
}
