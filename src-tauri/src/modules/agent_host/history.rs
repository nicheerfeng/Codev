//! Read-only access to native session transcripts.
use super::protocol::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub fn pi_home() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".pi/agent")))
}

/// Convert ISO-8601 UTC/offset string or integer timestamp into Unix milliseconds.
pub fn parse_timestamp_ms(value: Option<&Value>) -> u64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(n) = value.as_u64() {
        return if n < 10_000_000_000 { n * 1000 } else { n };
    }
    if let Some(f) = value.as_f64() {
        if f > 0.0 {
            let n = f as u64;
            return if n < 10_000_000_000 { n * 1000 } else { n };
        }
    }
    let Some(s) = value.as_str() else {
        return 0;
    };
    parse_iso_ms(s)
}

fn parse_iso_ms(s: &str) -> u64 {
    let b = s.trim().as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return 0;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(b.get(range)?).ok()?.parse::<i64>().ok()
    };
    let (Some(y), Some(m), Some(d), Some(hh), Some(mm), Some(ss)) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
    ) else {
        return 0;
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return 0;
    }
    let mut idx = 19;
    let mut ms = 0i64;
    if b.get(idx) == Some(&b'.') {
        idx += 1;
        let start = idx;
        while idx < b.len() && b[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = std::str::from_utf8(&b[start..idx]).unwrap_or("");
        let padded = format!("{frac:0<3}");
        ms = padded[..3].parse::<i64>().unwrap_or(0);
    }
    let mut tz_offset_secs = 0i64;
    if let Some(&sign) = b.get(idx) {
        if (sign == b'+' || sign == b'-') && idx + 6 <= b.len() {
            let oh = std::str::from_utf8(&b[idx + 1..idx + 3])
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            let om = if b.get(idx + 3) == Some(&b':') {
                std::str::from_utf8(&b[idx + 4..idx + 6])
            } else {
                std::str::from_utf8(&b[idx + 3..idx + 5])
            }
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
            let total = oh * 3600 + om * 60;
            tz_offset_secs = if sign == b'+' { total } else { -total };
        }
    }
    // Howard Hinnant civil-to-days algorithm
    let y_adj = y - i64::from(m <= 2);
    let era = y_adj.div_euclid(400);
    let yoe = y_adj.rem_euclid(400);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss - tz_offset_secs;
    if secs < 0 {
        0
    } else {
        (secs as u64).saturating_mul(1000).saturating_add(ms as u64)
    }
}

pub fn structured_diff(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    if let Some(s) = value.as_str() {
        return (!s.trim().is_empty()).then(|| json!({ "patch": s }));
    }
    if value.is_object() {
        return Some(value.clone());
    }
    None
}

pub fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    if let Some(content) = value.as_array() {
        return content
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn message_parts(value: &Value, id: &str) -> Vec<Message> {
    let role = text(value, "role");
    let content = value.get("content").cloned().unwrap_or(Value::Null);
    let created_at = parse_timestamp_ms(value.get("timestamp"));
    if role == "toolResult" {
        let is_error = value.get("isError") == Some(&json!(true));
        return vec![Message {
            id: id.into(),
            kind: "toolResult".into(),
            role: "tool".into(),
            text: content_text(&content),
            tool_call_id: text(value, "toolCallId"),
            tool_name: text(value, "toolName"),
            diff: structured_diff(value.pointer("/details/diff")),
            is_error,
            status: if is_error { "error" } else { "completed" }.into(),
            created_at,
            raw_kind: "message".into(),
            source_event_id: Some(id.into()),
            ..Message::default()
        }];
    }
    if role != "user" && role != "assistant" {
        return vec![];
    }
    let mut message = Message {
        id: id.into(),
        kind: "message".into(),
        role: role.clone(),
        text: content_text(&content),
        status: "completed".into(),
        created_at,
        raw_kind: "message".into(),
        source_event_id: Some(id.into()),
        ..Message::default()
    };
    let mut tools = vec![];
    if let Some(parts) = content.as_array() {
        for (i, part) in parts.iter().enumerate() {
            match text(part, "type").as_str() {
                "thinking" => {
                    if let Some(t) = part.get("thinking").and_then(Value::as_str) {
                        message.thinking.push_str(t);
                    }
                }
                "image" => {
                    let image = if part
                        .get("data")
                        .and_then(Value::as_str)
                        .map(|s| s.len() < 5 * 1024 * 1024)
                        .unwrap_or(false)
                    {
                        part.clone()
                    } else {
                        json!({"type":"image","mimeType":part.get("mimeType"),"unavailable":true})
                    };
                    message.images.push(image);
                }
                "toolCall" => tools.push(Message {
                    id: format!("{id}:tool:{i}"),
                    kind: "toolCall".into(),
                    role: "tool".into(),
                    tool_name: text(part, "name"),
                    tool_call_id: text(part, "id"),
                    arguments: part.get("arguments").cloned().unwrap_or(Value::Null),
                    status: "completed".into(),
                    created_at,
                    raw_kind: "message".into(),
                    source_event_id: Some(id.into()),
                    ..Message::default()
                }),
                _ => {}
            }
        }
    }
    if let Some(error) = value
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        message.is_error = true;
        message.status = "error".into();
        if message.text.is_empty() {
            message.text = error.into();
        }
    }
    let mut output = vec![];
    if !message.text.is_empty() || !message.thinking.is_empty() || !message.images.is_empty() {
        output.push(message);
    }
    output.extend(tools);
    output
}

pub fn push_with_tool_merge(messages: &mut Vec<Message>, part: Message) {
    if part.kind == "toolResult" && !part.tool_call_id.is_empty() {
        if let Some(call) = messages
            .iter_mut()
            .rev()
            .find(|m| m.kind == "toolCall" && m.tool_call_id == part.tool_call_id)
        {
            if !part.text.is_empty() {
                call.text = part.text;
            }
            if part.diff.is_some() {
                call.diff = part.diff;
            }
            call.is_error = part.is_error;
            call.status = part.status;
            return;
        }
    }
    messages.push(part);
}

/// Follow the active parent chain instead of concatenating different Pi branches.
pub fn read_pi(path: &Path, before: Option<usize>) -> Result<(Vec<Message>, usize), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
        return Err("会话超过 128 MiB，请先使用 Pi 导出或缩减历史".into());
    }
    let mut records: HashMap<String, (Option<String>, Value)> = HashMap::new();
    let mut leaf = None;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = text(&value, "id");
        if id.is_empty() || value.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        let parent = value
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        leaf = Some(id.clone());
        records.insert(id, (parent, value));
    }
    let mut chain = vec![];
    let mut seen = HashSet::new();
    while let Some(id) = leaf {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some((parent, value)) = records.get(&id) else {
            break;
        };
        chain.push((id, value.clone()));
        leaf = parent.clone();
    }
    chain.reverse();
    let mut messages: Vec<Message> = vec![];
    for (id, entry) in chain {
        let entry_ts = parse_timestamp_ms(entry.get("timestamp"));
        if let Some(value) = entry.get("message") {
            for mut part in message_parts(value, &id) {
                if part.created_at == 0 {
                    part.created_at = entry_ts;
                }
                push_with_tool_merge(&mut messages, part);
            }
        } else if text(&entry, "type") == "compaction" {
            messages.push(Message {
                id,
                kind: "notice".into(),
                role: "system".into(),
                text: "此处已由 Pi 压缩上下文".into(),
                status: "completed".into(),
                created_at: entry_ts,
                ..Message::default()
            });
        }
    }
    let end = before.unwrap_or(messages.len()).min(messages.len());
    let start = end.saturating_sub(200);
    Ok((messages[start..end].to_vec(), start))
}

/// Fast tail scan of a Pi JSONL session for `source_event_id` backfills and latest usage.
pub fn pi_tail_summary(path: &Path) -> (Vec<(String, String, String)>, Option<Value>) {
    let records = tail_records(path);
    let mut entries = vec![];
    let mut latest_usage = None;
    for record in &records {
        let id = text(record, "id");
        if let Some(message) = record.get("message") {
            let role = text(message, "role");
            if role == "assistant" {
                if let Some(usage) = message.get("usage") {
                    latest_usage = Some(usage.clone());
                }
            }
            if !id.is_empty() && (role == "user" || role == "assistant") {
                entries.push((
                    id,
                    role,
                    content_text(message.get("content").unwrap_or(&Value::Null)),
                ));
            }
        }
    }
    (entries, latest_usage)
}

fn tail_records(path: &Path) -> Vec<Value> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return vec![];
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(32768)));
    BufReader::new(file)
        .lines()
        .filter_map(Result::ok)
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect()
}
pub fn read_codex(path: &Path, before: Option<usize>) -> Result<(Vec<Message>, usize), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
        return Err("历史过大，请在原生命令行中打开".into());
    }
    let mut output: Vec<Message> = vec![];
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts = parse_timestamp_ms(v.get("timestamp"));
        if text(&v, "type") != "response_item" {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        let ptype = text(payload, "type");
        match ptype.as_str() {
            "reasoning" => {
                let summary = payload
                    .get("summary")
                    .or_else(|| payload.get("content"))
                    .map(content_text)
                    .unwrap_or_default();
                if summary.trim().is_empty() {
                    continue;
                }
                if let Some(last) = output.last_mut().filter(|m| {
                    m.kind == "message" && m.role == "assistant" && m.thinking.is_empty()
                }) {
                    last.thinking = summary;
                } else {
                    output.push(Message {
                        id: format!("codex:{i}:reasoning"),
                        kind: "message".into(),
                        role: "assistant".into(),
                        thinking: summary,
                        status: "completed".into(),
                        created_at: ts,
                        raw_kind: ptype,
                        ..Message::default()
                    });
                }
            }
            "function_call" | "custom_tool_call" => {
                let call_id = text(payload, "call_id");
                let name = text(payload, "name");
                let raw_args = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let arguments = if let Some(s) = raw_args.as_str() {
                    serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({ "input": s }))
                } else {
                    raw_args.clone()
                };
                let diff = if name == "apply_patch" {
                    raw_args.as_str().and_then(|s| structured_diff(Some(&json!(s))))
                } else {
                    None
                };
                output.push(Message {
                    id: format!("codex:{i}"),
                    kind: "toolCall".into(),
                    role: "tool".into(),
                    tool_name: name,
                    tool_call_id: call_id,
                    arguments,
                    diff,
                    status: "completed".into(),
                    created_at: ts,
                    raw_kind: ptype,
                    ..Message::default()
                });
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = text(payload, "call_id");
                let raw_out = payload.get("output").cloned().unwrap_or(Value::Null);
                let (out_text, is_error) = if let Some(s) = raw_out.as_str() {
                    if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                        let exit_err = parsed
                            .pointer("/metadata/exit_code")
                            .and_then(Value::as_i64)
                            .is_some_and(|code| code != 0);
                        let body = parsed
                            .get("output")
                            .and_then(Value::as_str)
                            .unwrap_or(s)
                            .to_string();
                        (body, exit_err)
                    } else {
                        (s.to_string(), false)
                    }
                } else {
                    (content_text(&raw_out), false)
                };
                if let Some(call) = output
                    .iter_mut()
                    .rev()
                    .find(|m| m.kind == "toolCall" && !call_id.is_empty() && m.tool_call_id == call_id)
                {
                    if !out_text.is_empty() {
                        call.text = out_text;
                    }
                    call.is_error = is_error;
                    call.status = if is_error { "error" } else { "completed" }.into();
                } else {
                    output.push(Message {
                        id: format!("codex:{i}"),
                        kind: "toolResult".into(),
                        role: "tool".into(),
                        tool_call_id: call_id,
                        text: out_text,
                        is_error,
                        status: if is_error { "error" } else { "completed" }.into(),
                        created_at: ts,
                        raw_kind: ptype,
                        ..Message::default()
                    });
                }
            }
            _ => {
                for mut part in message_parts(payload, &format!("codex:{i}")) {
                    if part.created_at == 0 {
                        part.created_at = ts;
                    }
                    output.push(part);
                }
            }
        }
    }
    let end = before.unwrap_or(output.len()).min(output.len());
    let start = end.saturating_sub(200);
    Ok((output[start..end].to_vec(), start))
}
