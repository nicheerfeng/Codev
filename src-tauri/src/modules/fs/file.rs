use std::path::Path;
use std::time::UNIX_EPOCH;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tempfile::NamedTempFile;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Ceiling for explicit "open anyway"; mirrored as FORCE_READ_LIMIT in useDocument.ts.
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const PREVIEW_MAX_LINES: u64 = 300;
const SEARCH_MAX_MATCHES: usize = 2_000;

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
#[serde(rename_all = "camelCase")]
pub struct TextWindow {
    pub content: String,
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub offset: u64,
    pub line_start: u64,
    pub line: u64,
    pub column: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchResult {
    pub matches: Vec<TextMatch>,
    pub total: u64,
    pub truncated: bool,
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

/// 返回单个文本文件的字面量命中位置，按行流式读取以限制内存占用。
#[tauri::command]
pub async fn fs_find_text(
    path: String,
    query: String,
    case_sensitive: Option<bool>,
    max_matches: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<TextSearchResult, String> {
    if query.is_empty() {
        return Ok(TextSearchResult {
            matches: Vec::new(),
            total: 0,
            truncated: false,
        });
    }
    if query.contains(['\n', '\r']) {
        return Err("跨行搜索暂不支持".to_string());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    find_text_sync(
        &resolve_path(&path, &workspace),
        &query,
        case_sensitive.unwrap_or(false),
        max_matches.unwrap_or(SEARCH_MAX_MATCHES).clamp(1, SEARCH_MAX_MATCHES),
    )
}

/// 对单个文本文件执行字面量替换，使用临时文件完成原子更新。
#[tauri::command]
pub async fn fs_replace_text(
    path: String,
    query: String,
    replacement: String,
    case_sensitive: Option<bool>,
    match_offset: Option<u64>,
    replace_all: Option<bool>,
    workspace: Option<WorkspaceEnv>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    if query.is_empty() {
        return Ok(0);
    }
    if query.contains(['\n', '\r']) {
        return Err("跨行替换暂不支持".to_string());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let target_path = resolve_path(&path, &workspace);
    let replaced = replace_text_sync(
        &target_path,
        &query,
        &replacement,
        case_sensitive.unwrap_or(false),
        match_offset,
        replace_all.unwrap_or(false),
    )?;
    if replaced == 0 {
        return Ok(0);
    }
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path,
            source: Some("search".to_string()),
        },
    );
    Ok(replaced)
}

/// 将当前外部媒体文件加入 asset scope，供图片、PDF 和音视频直接读取。
#[tauri::command]
pub fn fs_allow_asset(path: String, app: AppHandle) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(Path::new(&path))
        .map_err(|error| error.to_string())
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

/// 查找一行中的普通字面量位置，大小写忽略只折叠 ASCII 以保持字节偏移稳定。
fn literal_positions(line: &str, query: &str, case_sensitive: bool) -> Vec<usize> {
    if case_sensitive {
        return line.match_indices(query).map(|(offset, _)| offset).collect();
    }
    let folded_line = line.to_ascii_lowercase();
    let folded_query = query.to_ascii_lowercase();
    folded_line
        .match_indices(&folded_query)
        .map(|(offset, _)| offset)
        .collect()
}

/// 流式扫描文本文件并返回有限数量的命中位置。
fn find_text_sync(
    path: &Path,
    query: &str,
    case_sensitive: bool,
    max_matches: usize,
) -> Result<TextSearchResult, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut line_bytes = Vec::with_capacity(8 * 1024);
    let mut line_start = 0_u64;
    let mut line_number = 1_u64;
    let mut total = 0_u64;
    let mut matches = Vec::with_capacity(max_matches.min(128));

    loop {
        line_bytes.clear();
        let read = reader
            .read_until(b'\n', &mut line_bytes)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        let line = std::str::from_utf8(&line_bytes)
            .map_err(|_| "该文件不是 UTF-8 文本，无法搜索".to_string())?;
        for offset in literal_positions(line, query, case_sensitive) {
            total += 1;
            if matches.len() < max_matches {
                matches.push(TextMatch {
                    offset: line_start + offset as u64,
                    line_start,
                    line: line_number,
                    column: line[..offset].chars().count() as u64 + 1,
                });
            }
        }
        line_start += read as u64;
        line_number += 1;
    }

    Ok(TextSearchResult {
        matches,
        total,
        truncated: total as usize > max_matches,
    })
}

/// 流式替换单个或全部字面量命中，并保留原文件权限。
fn replace_text_sync(
    target: &Path,
    query: &str,
    replacement: &str,
    case_sensitive: bool,
    match_offset: Option<u64>,
    replace_all: bool,
) -> Result<u64, String> {
    let original_permissions = fs::metadata(target).ok().map(|m| m.permissions());
    let file = fs::File::open(target).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let mut temp = NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let mut line_bytes = Vec::with_capacity(8 * 1024);
    let mut line_start = 0_u64;
    let mut replaced = 0_u64;

    loop {
        line_bytes.clear();
        let read = reader
            .read_until(b'\n', &mut line_bytes)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        let line = std::str::from_utf8(&line_bytes)
            .map_err(|_| "该文件不是 UTF-8 文本，无法替换".to_string())?;
        let positions = literal_positions(line, query, case_sensitive);
        let mut cursor = 0_usize;
        let mut output = Vec::with_capacity(line.len());
        for offset in &positions {
            let absolute = line_start + *offset as u64;
            let selected = match match_offset {
                Some(target_offset) => target_offset == absolute,
                None => replaced == 0,
            };
            if !replace_all && !selected {
                continue;
            }
            output.extend_from_slice(&line.as_bytes()[cursor..*offset]);
            output.extend_from_slice(replacement.as_bytes());
            cursor = *offset + query.len();
            replaced += 1;
            if !replace_all {
                break;
            }
        }
        if replaced == 0 && positions.is_empty() {
            temp.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            output.extend_from_slice(&line.as_bytes()[cursor..]);
            temp.write_all(&output).map_err(|e| e.to_string())?;
        }
        line_start += read as u64;
    }

    if replaced == 0 {
        return Ok(0);
    }
    drop(reader);
    temp.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.error.to_string())?;
    if let Some(permissions) = original_permissions {
        let _ = fs::set_permissions(target, permissions);
    }
    Ok(replaced)
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

    /// 校验字面量搜索返回稳定的字节偏移和行号。
    #[test]
    fn finds_literal_text_without_regex() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("service.log");
        std::fs::write(&file, "Start\nrestart service\nrestart again\n").unwrap();

        let result = find_text_sync(&file, "restart", false, SEARCH_MAX_MATCHES).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.matches[0].line, 2);
        assert_eq!(result.matches[1].line, 3);
        assert!(!result.truncated);
    }

    /// 校验单项替换和全部替换都通过原子文件更新完成。
    #[test]
    fn replaces_current_or_all_literal_matches() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("service.log");
        std::fs::write(&file, "restart\nrestart\n").unwrap();

        let first = find_text_sync(&file, "restart", false, SEARCH_MAX_MATCHES)
            .unwrap()
            .matches[0]
            .offset;
        assert_eq!(
            replace_text_sync(&file, "restart", "start", false, Some(first), false).unwrap(),
            1
        );
        assert_eq!(
            replace_text_sync(&file, "restart", "start", false, None, true).unwrap(),
            1
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "start\nstart\n");
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
