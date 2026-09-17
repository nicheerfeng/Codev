//! Pi 会话 JSONL 摘要、分页历史和文件操作；运行时 IPC 留在父模块。
use super::paths::{canonical_display, pi_sessions_dir, same_path};
use super::{
    list_models_from_file, PiClonedSession, PiListedModel, PiSessionAppendRequest,
    PiSessionHistory, PiSessionSummary,
};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const JSONL_CHUNK: u64 = 64 * 1024;

/// 提取用户消息的简短预览。
pub(super) fn message_preview(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let text = if let Some(value) = content.as_str() {
        value.to_string()
    } else {
        content
            .as_array()?
            .iter()
            .find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
            })?
            .to_string()
    };
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact.chars().take(80).collect())
    }
}

/// 解析一个 Pi JSONL 文件的轻量线程摘要。
pub(super) fn parse_session_summary(
    path: &Path,
    expected_cwd: Option<&str>,
) -> Option<PiSessionSummary> {
    let file = File::open(path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut name = None;
    let mut preview = None;
    let mut message_count = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                id = value.get("id").and_then(Value::as_str).map(str::to_string);
                cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
                created_at = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(expected) = expected_cwd {
                    if !cwd
                        .as_deref()
                        .is_some_and(|value| same_path(value, expected))
                    {
                        return None;
                    }
                }
            }
            Some("session_info") => {
                name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("message") => {
                message_count += 1;
                if preview.is_none() {
                    preview = value.get("message").and_then(message_preview);
                }
            }
            _ => {}
        }
    }

    let metadata = path.metadata().ok()?;
    let updated_at = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(PiSessionSummary {
        path: canonical_display(path),
        id: id?,
        cwd: cwd?,
        name,
        preview,
        created_at: created_at.unwrap_or_default(),
        updated_at,
        message_count,
    })
}

/// 校验路径是 Pi 会话目录内的 jsonl 文件。
fn resolve_session_file(path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    let root = pi_sessions_dir()
        .ok_or("无法定位 Pi 会话目录")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(&root)
        || !resolved.is_file()
        || resolved.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("仅允许使用 Pi 会话目录中的会话文件".into());
    }
    Ok(resolved)
}

/// 判断公历年份是否为闰年。
fn is_leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

/// 生成 UTC RFC3339 时间，避免引入 chrono。
fn utc_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut days = duration.as_secs() / 86400;
    let remain = duration.as_secs() % 86400;
    let hour = remain / 3600;
    let minute = (remain % 3600) / 60;
    let second = remain % 60;
    let millis = duration.subsec_millis();
    let mut year = 1970u64;
    loop {
        let year_days = if is_leap(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let month_days = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for days_in_month in month_days {
        if days < days_in_month {
            break;
        }
        days -= days_in_month;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        day = days + 1
    )
}

/// 按现有规则生成会话条目 ID。
fn new_entry_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
        now.as_secs() as u32,
        (now.subsec_nanos() >> 16) as u16,
        now.subsec_nanos() & 0xfff,
        std::process::id() & 0xfff,
        now.as_nanos() % 0x1_0000_0000_0000
    )
}

/// 保存 JSONL 条目的文件偏移与原始数据。
struct JsonlRecord {
    offset: u64,
    value: Value,
}

/// 从后往前扫描 JSONL，每条记录带上文件偏移。
fn visit_jsonl_rev(
    path: &Path,
    before: u64,
    mut visit: impl FnMut(JsonlRecord) -> bool,
) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut remain = before;
    let mut tail: Vec<u8> = Vec::new();
    while remain > 0 {
        let start = remain.saturating_sub(JSONL_CHUNK);
        let length = (remain - start) as usize;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut chunk = vec![0u8; length];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        chunk.append(&mut tail);
        let mut cut = 0usize;
        if start > 0 {
            match chunk.iter().position(|&byte| byte == b'\n') {
                Some(index) => {
                    tail = chunk[..=index].to_vec();
                    cut = index + 1;
                }
                None => {
                    tail = chunk;
                    remain = start;
                    continue;
                }
            }
        }
        let region = &chunk[cut..];
        let region_start = start + cut as u64;
        let mut ranges = Vec::new();
        let mut line_start = 0usize;
        for (index, byte) in region.iter().enumerate() {
            if *byte == b'\n' {
                let mut line_end = index;
                if line_end > line_start && region[line_end - 1] == b'\r' {
                    line_end -= 1;
                }
                ranges.push((region_start + line_start as u64, line_start, line_end));
                line_start = index + 1;
            }
        }
        if line_start < region.len() {
            let mut line_end = region.len();
            if line_end > line_start && region[line_end - 1] == b'\r' {
                line_end -= 1;
            }
            ranges.push((region_start + line_start as u64, line_start, line_end));
        }
        for (offset, from, to) in ranges.into_iter().rev() {
            if from >= to {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&region[from..to]) {
                if !visit(JsonlRecord { offset, value }) {
                    return Ok(());
                }
            }
        }
        remain = start;
    }
    Ok(())
}

/// 读取不同模型格式中的 token 用量。
fn usage_tokens(usage: &Value) -> Option<u64> {
    usage
        .get("totalTokens")
        .or_else(|| usage.get("tokens"))
        .or_else(|| usage.get("inputTokens"))
        .or_else(|| usage.get("input"))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|number| number.round() as u64))
        })
}

/// 将 token 用量转换为上下文百分比。
fn context_ratio(tokens: u64, window: u64) -> f64 {
    ((tokens as f64) / (window as f64) * 100.0).min(100.0)
}

/// 按模型标识匹配目录配置。
fn find_listed_model<'a>(
    models: &'a [PiListedModel],
    provider: &str,
    id: &str,
) -> Option<&'a PiListedModel> {
    if let Some(exact) = models
        .iter()
        .find(|listed| listed.provider == provider && listed.id == id)
    {
        return Some(exact);
    }
    let matches: Vec<_> = models.iter().filter(|listed| listed.id == id).collect();
    match matches.as_slice() {
        [] => None,
        [only] => Some(*only),
        many => many
            .iter()
            .copied()
            .max_by_key(|listed| listed.context_window.unwrap_or(0)),
    }
}

/// 用模型目录补全上下文容量和用量。
fn apply_catalog_window(
    model: &mut Value,
    context_tokens: Option<u64>,
    context_percent: &mut Option<f64>,
) {
    let Some(provider) = model
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some(id) = model.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let Ok(models) = list_models_from_file() else {
        return;
    };
    let Some(listed) = find_listed_model(&models, &provider, &id) else {
        return;
    };
    if model.get("name").and_then(Value::as_str).is_none() {
        if let Some(name) = &listed.name {
            model["name"] = json!(name);
        }
    }
    let Some(window) = listed.context_window.filter(|window| *window > 0) else {
        return;
    };
    if model.get("contextWindow").is_none() {
        model["contextWindow"] = json!(window);
    }
    if context_percent.is_none() {
        if let Some(tokens) = context_tokens {
            *context_percent = Some(context_ratio(tokens, window));
        }
    }
}

/// 从助手消息提取模型标识。
fn assistant_model(message: &Value) -> Option<Value> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let provider = message.get("provider").and_then(Value::as_str)?;
    let id = message
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| message.get("modelId").and_then(Value::as_str))?;
    Some(json!({
        "provider": provider,
        "id": id,
        "name": message.get("name").and_then(Value::as_str),
    }))
}

/// 读取会话文件中的最新名称。
fn peek_session_name(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut name = None;
    for _ in 0..48 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            if let Some(value) = value.get("name").and_then(Value::as_str) {
                name = Some(value.to_string());
            }
        }
    }
    name
}

/// 查找会话中最后一个有效条目 ID。
fn last_entry_id(path: &Path) -> Result<Value, String> {
    let size = path.metadata().map_err(|error| error.to_string())?.len();
    let mut found = Value::Null;
    visit_jsonl_rev(path, size, |record| {
        if record.value.get("type").and_then(Value::as_str) == Some("session") {
            return true;
        }
        if let Some(id) = record.value.get("id").cloned() {
            found = id;
            return false;
        }
        true
    })?;
    Ok(found)
}

/// 从末尾分页读取消息，并带回模型、会话名称和思考等级，不启动 Pi runtime。
pub(super) fn parse_session_history(
    path: &Path,
    before: Option<u64>,
    limit: usize,
) -> Result<PiSessionHistory, String> {
    let resolved = resolve_session_file(path)?;
    let file_len = resolved
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let end = before.unwrap_or(file_len).min(file_len);
    let page = limit.max(1);
    let mut newest_first = Vec::new();
    let mut model = None;
    let mut thinking_level = None;
    let mut session_name = None;
    let mut oldest_offset = 0;
    let mut has_more = false;
    let mut context_tokens = None;
    let mut context_percent = None;
    visit_jsonl_rev(&resolved, end, |record| {
        match record.value.get("type").and_then(Value::as_str) {
            Some("session_info") if session_name.is_none() => {
                session_name = record
                    .value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                true
            }
            Some("model_change") if model.is_none() => {
                if let (Some(provider), Some(id)) = (
                    record.value.get("provider").and_then(Value::as_str),
                    record.value.get("modelId").and_then(Value::as_str),
                ) {
                    model = Some(json!({
                        "provider": provider,
                        "id": id,
                        "name": record.value.get("name").and_then(Value::as_str),
                    }));
                }
                true
            }
            Some("thinking_level_change") if thinking_level.is_none() => {
                thinking_level = record
                    .value
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                true
            }
            Some("message") => {
                let Some(message) = record.value.get("message").cloned() else {
                    return true;
                };
                let usage = message.get("usage").or_else(|| record.value.get("usage"));
                let context = usage.and_then(|value| value.get("contextUsage")).or(usage);
                if let Some(context) = context {
                    if context_tokens.is_none() {
                        context_tokens = usage_tokens(context);
                    }
                    if context_percent.is_none() {
                        context_percent = context.get("percent").and_then(Value::as_f64);
                    }
                }
                if model.is_none() {
                    model = assistant_model(&message);
                }
                if newest_first.len() < page {
                    newest_first.push(json!({
                        "id": record.value.get("id"),
                        "timestamp": record.value.get("timestamp"),
                        "message": message,
                    }));
                    oldest_offset = record.offset;
                } else {
                    has_more = true;
                }
                newest_first.len() < page
                    || model.is_none()
                    || thinking_level.is_none()
                    || session_name.is_none()
                    || context_tokens.is_none()
            }
            _ => {
                newest_first.len() < page
                    || model.is_none()
                    || thinking_level.is_none()
                    || session_name.is_none()
                    || context_tokens.is_none()
            }
        }
    })?;
    if session_name.is_none() && before.is_none() {
        session_name = peek_session_name(&resolved);
    }
    newest_first.reverse();
    if let Some(model) = model.as_mut() {
        apply_catalog_window(model, context_tokens, &mut context_percent);
    }
    Ok(PiSessionHistory {
        messages: newest_first,
        model,
        thinking_level,
        session_name,
        session_file: canonical_display(&resolved),
        oldest_offset,
        has_more,
        context_tokens,
        context_percent,
    })
}

pub(super) fn clone_session_file(path: &Path) -> Result<PiClonedSession, String> {
    let source = resolve_session_file(path)?;
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let mut lines = content.lines();
    let header_line = lines.next().ok_or("会话文件为空")?;
    let mut header: Value = serde_json::from_str(header_line).map_err(|error| error.to_string())?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("会话头无效".into());
    }
    let new_id = new_entry_id();
    let timestamp = utc_timestamp();
    header["id"] = json!(new_id);
    header["timestamp"] = json!(timestamp);
    header["parentSession"] = json!(canonical_display(&source));
    let directory = source.parent().ok_or("会话目录不存在")?;
    let file_stamp = timestamp.replace(':', "-");
    let dest = directory.join(format!("{file_stamp}_{new_id}.jsonl"));
    let mut output = header.to_string();
    output.push('\n');
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }
    fs::write(&dest, output).map_err(|error| error.to_string())?;
    Ok(PiClonedSession {
        path: canonical_display(&dest),
        id: new_id,
        name: None,
    })
}

pub(super) fn append_session_entry(request: PiSessionAppendRequest) -> Result<(), String> {
    let path = resolve_session_file(Path::new(&request.path))?;
    let parent_id = last_entry_id(&path)?;
    let id = new_entry_id();
    let timestamp = utc_timestamp();
    let entry = match request.kind.as_str() {
        "session_info" => json!({
            "type": "session_info",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "name": request.name.filter(|value| !value.trim().is_empty()).ok_or("缺少会话名称")?,
        }),
        "model_change" => json!({
            "type": "model_change",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "provider": request.provider.filter(|value| !value.trim().is_empty()).ok_or("缺少 provider")?,
            "modelId": request.model_id.filter(|value| !value.trim().is_empty()).ok_or("缺少 modelId")?,
        }),
        "thinking_level_change" => json!({
            "type": "thinking_level_change",
            "id": id,
            "parentId": parent_id,
            "timestamp": timestamp,
            "thinkingLevel": request.thinking_level.filter(|value| !value.trim().is_empty()).ok_or("缺少 thinkingLevel")?,
        }),
        _ => return Err("不支持的会话写入类型".into()),
    };
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{entry}").map_err(|error| error.to_string())
}

/// 扫描会话目录并返回属于指定工作目录的最近线程。
pub(super) fn list_sessions(cwd: Option<&str>, limit: usize) -> Vec<PiSessionSummary> {
    let Some(root) = pi_sessions_dir() else {
        return Vec::new();
    };
    let mut pending = vec![root];
    let mut summaries = Vec::new();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                if let Some(summary) = parse_session_summary(&path, cwd) {
                    summaries.push(summary);
                }
            }
        }
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    summaries.truncate(limit);
    summaries
}

/// 校验真实路径与会话格式后仅删除该文件。
pub(super) fn delete_session_file(root: &Path, target: &Path) -> Result<(), String> {
    let resolved = target.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.starts_with(root)
        || !resolved.is_file()
        || resolved.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || parse_session_summary(&resolved, None).is_none()
    {
        return Err("仅允许删除 Pi 会话目录中的会话文件".into());
    }
    std::fs::remove_file(resolved).map_err(|error| error.to_string())
}
