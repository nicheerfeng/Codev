use std::path::Path;
use std::time::UNIX_EPOCH;
use std::{
    fs,
    io::{BufReader, Read, Seek, SeekFrom, Write},
};

use serde::Serialize;
use tauri::Emitter;
use tempfile::NamedTempFile;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Ceiling for explicit "open anyway"; mirrored as FORCE_READ_LIMIT in useDocument.ts.
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const PREVIEW_MAX_LINES: u64 = 300;
const PREVIEW_MAX_ROWS: usize = 100;
const PREVIEW_MAX_COLUMNS: usize = 30;
const PREVIEW_MAX_CELL_BYTES: usize = 16 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        mtime: u64,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

#[derive(Serialize)]
pub struct TextWindow {
    pub content: String,
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub has_more: bool,
}

#[derive(Serialize)]
pub struct CsvWindow {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub has_more: bool,
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 以固定字节和行数上限读取 UTF-8 文本窗口，避免把大日志整体载入内存。
fn read_text_window_sync(
    p: &Path,
    offset: u64,
    max_bytes: u64,
    max_lines: u64,
) -> Result<TextWindow, String> {
    let total_bytes = fs::metadata(p).map_err(|e| e.to_string())?.len();
    let start = offset.min(total_bytes);
    let byte_limit = max_bytes.clamp(1024, PREVIEW_MAX_BYTES) as usize;
    let line_limit = max_lines.clamp(1, PREVIEW_MAX_LINES) as usize;
    let mut file = fs::File::open(p).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;

    let mut bytes = Vec::with_capacity(byte_limit);
    let mut buffer = [0_u8; 8192];
    let mut line_count = 0_usize;
    while bytes.len() < byte_limit && line_count < line_limit {
        let remaining = (byte_limit - bytes.len()).min(buffer.len());
        let count = file
            .read(&mut buffer[..remaining])
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            bytes.push(*byte);
            if *byte == b'\n' {
                line_count += 1;
                if line_count >= line_limit {
                    break;
                }
            }
        }
    }

    if bytes.contains(&0) {
        return Err("该文件包含二进制内容，无法按文本窗口预览".to_string());
    }
    let valid_len = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => error.valid_up_to(),
        Err(_) => return Err("该文件不是 UTF-8 文本，无法按文本窗口预览".to_string()),
    };
    let content = String::from_utf8(bytes[..valid_len].to_vec()).map_err(|e| e.to_string())?;
    let next_offset = start + valid_len as u64;
    Ok(TextWindow {
        content,
        offset: start,
        next_offset,
        total_bytes,
        has_more: next_offset < total_bytes,
    })
}

/// 将 CSV 单元格压缩到预览上限，防止异常长字段扩大渲染内存。
fn preview_csv_cell(bytes: &[u8], truncated: bool) -> Result<String, String> {
    let value = match std::str::from_utf8(bytes) {
        Ok(value) => value.to_string(),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|e| e.to_string())?
                .to_string()
        }
        Err(_) => return Err("CSV 包含非 UTF-8 字段，无法预览".to_string()),
    };
    Ok(if truncated {
        format!("{value}…")
    } else {
        value
    })
}

/// 从缓冲输入中读取一条 CSV/TSV 记录，支持引号、转义引号和跨行字段。
fn read_delimited_record<R: Read>(
    reader: &mut R,
    delimiter: u8,
    position: &mut u64,
) -> Result<Option<Vec<String>>, String> {
    enum State {
        Plain,
        Quoted,
        QuoteEnd,
    }

    let mut state = State::Plain;
    let mut row = Vec::new();
    let mut field = Vec::new();
    let mut truncated = false;
    let mut saw_content = false;
    let mut byte = [0_u8; 1];

    loop {
        let count = reader.read(&mut byte).map_err(|e| e.to_string())?;
        if count == 0 {
            if matches!(state, State::Quoted) {
                return Err("CSV 引号字段未闭合".to_string());
            }
            if !saw_content && row.is_empty() && field.is_empty() {
                return Ok(None);
            }
            row.push(preview_csv_cell(&field, truncated)?);
            return Ok(Some(row));
        }
        *position += 1;
        let current = byte[0];
        saw_content = true;

        match state {
            State::Plain if current == delimiter => {
                row.push(preview_csv_cell(&field, truncated)?);
                field.clear();
                truncated = false;
            }
            State::Plain if current == b'\n' => {
                row.push(preview_csv_cell(&field, truncated)?);
                return Ok(Some(row));
            }
            State::Plain if current == b'\r' => {}
            State::Plain if current == b'"' && field.is_empty() => state = State::Quoted,
            State::Plain => {
                if field.len() < PREVIEW_MAX_CELL_BYTES {
                    field.push(current);
                } else {
                    truncated = true;
                }
            }
            State::Quoted if current == b'"' => state = State::QuoteEnd,
            State::Quoted => {
                if field.len() < PREVIEW_MAX_CELL_BYTES {
                    field.push(current);
                } else {
                    truncated = true;
                }
            }
            State::QuoteEnd if current == b'"' => {
                if field.len() < PREVIEW_MAX_CELL_BYTES {
                    field.push(current);
                } else {
                    truncated = true;
                }
                state = State::Quoted;
            }
            State::QuoteEnd if current == delimiter => {
                row.push(preview_csv_cell(&field, truncated)?);
                field.clear();
                truncated = false;
                state = State::Plain;
            }
            State::QuoteEnd if current == b'\n' => {
                row.push(preview_csv_cell(&field, truncated)?);
                return Ok(Some(row));
            }
            State::QuoteEnd if current == b'\r' => {}
            State::QuoteEnd => {
                return Err("CSV 引号字段结束后包含非法字符".to_string());
            }
        }
    }
}

/// 读取 CSV/TSV 的一页记录，始终把内存、行数和列数限定在预览范围内。
fn read_csv_window_sync(
    p: &Path,
    offset: u64,
    max_rows: usize,
    delimiter: u8,
) -> Result<CsvWindow, String> {
    if delimiter != b',' && delimiter != b'\t' {
        return Err("仅支持 CSV 和 TSV 分隔符".to_string());
    }
    let total_bytes = fs::metadata(p).map_err(|e| e.to_string())?.len();
    let start = offset.min(total_bytes);

    let mut header_position = 0_u64;
    let mut header_reader = BufReader::new(fs::File::open(p).map_err(|e| e.to_string())?);
    let headers = read_delimited_record(&mut header_reader, delimiter, &mut header_position)?
        .unwrap_or_default()
        .into_iter()
        .take(PREVIEW_MAX_COLUMNS)
        .collect();

    let mut file = fs::File::open(p).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut position = start;
    if start == 0 {
        let _ = read_delimited_record(&mut reader, delimiter, &mut position)?;
    }

    let row_limit = max_rows.clamp(1, PREVIEW_MAX_ROWS);
    let mut rows = Vec::with_capacity(row_limit);
    while rows.len() < row_limit && position.saturating_sub(start) < PREVIEW_MAX_BYTES {
        let Some(row) = read_delimited_record(&mut reader, delimiter, &mut position)? else {
            break;
        };
        if position.saturating_sub(start) > PREVIEW_MAX_BYTES {
            return Err("CSV 单页记录超过 512 KB 预览上限".to_string());
        }
        rows.push(row.into_iter().take(PREVIEW_MAX_COLUMNS).collect());
    }

    let next_offset = if position <= start && start < total_bytes {
        total_bytes
    } else {
        position.min(total_bytes)
    };
    Ok(CsvWindow {
        headers,
        rows,
        offset: start,
        next_offset,
        total_bytes,
        has_more: next_offset < total_bytes,
    })
}

#[tauri::command]
pub async fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    read_file_sync(&resolve_path(&path, &workspace), force.unwrap_or(false))
}

/// 按页返回大文本的局部内容，供日志和 JSONL 预览使用。
#[tauri::command]
pub async fn fs_read_text_window(
    path: String,
    offset: u64,
    max_bytes: u64,
    max_lines: u64,
    workspace: Option<WorkspaceEnv>,
) -> Result<TextWindow, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    read_text_window_sync(
        &resolve_path(&path, &workspace),
        offset,
        max_bytes,
        max_lines,
    )
}

/// 按页返回 CSV 或 TSV 的表头和记录，避免将整张表加载到前端。
#[tauri::command]
pub async fn fs_read_csv_window(
    path: String,
    offset: u64,
    max_rows: usize,
    delimiter: u8,
    workspace: Option<WorkspaceEnv>,
) -> Result<CsvWindow, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    read_csv_window_sync(
        &resolve_path(&path, &workspace),
        offset,
        max_rows,
        delimiter,
    )
}

fn read_file_sync(p: &Path, force: bool) -> Result<ReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }

    let bytes = std::fs::read(p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // Null-byte sniff on the first chunk. Not perfect (misses UTF-16 BOM
    // cases) but catches the common "this is a PNG" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            mtime: mtime_millis(&meta),
        }),
        Err(_) => Ok(ReadResult::Binary { size }),
    }
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Atomic write via O_EXCL tempfile in the target's parent, then rename.
/// The random suffix is what blocks pre-staged symlink attacks.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// Returns the new mtime so the editor can track disk state for conflict
/// detection without a follow-up stat.
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = resolve_path(&path, &workspace);
    let original_permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    write_atomic(&target, content.as_bytes()).map_err(|e| {
        log::warn!("fs_write_file({}) failed: {e}", target.display());
        e.to_string()
    })?;

    if let Some(perms) = original_permissions {
        let _ = fs::set_permissions(&target, perms);
    }
    let mtime = fs::metadata(&target)
        .map(|m| mtime_millis(&m))
        .unwrap_or(0);
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path: path.clone(),
            source,
        },
    );

    Ok(mtime)
}

#[tauri::command]
pub async fn fs_canonicalize(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    Ok(super::to_canon(&canon))
}

#[tauri::command]
pub async fn fs_stat(path: String, workspace: Option<WorkspaceEnv>) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    // fs::metadata follows symlinks, so the link check needs symlink_metadata.
    let kind = if std::fs::symlink_metadata(&p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_millis(&meta),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_file_classifies_utf8_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"hello world").unwrap();
        match read_file_sync(&f, false).unwrap() {
            ReadResult::Text {
                content,
                size,
                mtime,
            } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0);
            }
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn read_file_detects_binary_via_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"PNG\0\x89image").unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_detects_binary_via_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        // Invalid UTF-8 with no null byte: must still classify as binary.
        std::fs::write(&f, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn force_lifts_the_default_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        std::fs::write(&f, vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::TooLarge { .. }
        ));
        assert!(matches!(
            read_file_sync(&f, true).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    // 校验文本预览仅保留当前窗口，并能从下一偏移继续读取。
    #[test]
    fn text_window_reads_in_bounded_pages() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("service.log");
        std::fs::write(&file, "first\nsecond\nthird\n").unwrap();

        let first = read_text_window_sync(&file, 0, 1024, 1).unwrap();
        assert_eq!(first.content, "first\n");
        assert!(first.has_more);

        let second = read_text_window_sync(&file, first.next_offset, 1024, 1).unwrap();
        assert_eq!(second.content, "second\n");
    }

    // 校验 CSV 预览保留表头，并能在带引号字段后继续分页。
    #[test]
    fn csv_window_reads_quoted_records_in_pages() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data.csv");
        std::fs::write(
            &file,
            "name,note\nfirst,\"a,b\"\nsecond,\"two\nlines\"\nthird,done\n",
        )
        .unwrap();

        let first = read_csv_window_sync(&file, 0, 1, b',').unwrap();
        assert_eq!(first.headers, ["name", "note"]);
        assert_eq!(
            first.rows,
            vec![vec!["first".to_string(), "a,b".to_string()]]
        );

        let second = read_csv_window_sync(&file, first.next_offset, 2, b',').unwrap();
        assert_eq!(second.rows[0], ["second", "two\nlines"]);
        assert_eq!(second.rows[1], ["third", "done"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.terax.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }
}
