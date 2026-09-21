use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 从末尾分块读取最近用量，长消息行直接跳过，避免载入整份历史。
fn read_usage(path: &Path) -> Result<Option<Value>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut offset = file.metadata().map_err(|error| error.to_string())?.len();
    let mut chunk = vec![0; 64 * 1024];
    let mut line = Vec::new();
    let mut oversized = false;
    let mut usage = None;
    let mut effort = None;
    // 同一次倒序读取恢复用量和最近轮次设置，不读取其他线程。
    let mut consume = |line: &[u8]| {
        if usage.is_none() { usage = parse_usage(line); }
        if effort.is_none() {
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                if value["type"] == "turn_context" {
                    effort = value["payload"]["effort"].as_str()
                        .or_else(|| value["payload"]["reasoning_effort"].as_str())
                        .filter(|value| !value.trim().is_empty()).map(str::to_owned);
                }
            }
        }
        usage.is_some() && effort.is_some()
    };
    while offset > 0 {
        let size = offset.min(chunk.len() as u64) as usize;
        offset -= size as u64;
        file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
        file.read_exact(&mut chunk[..size]).map_err(|error| error.to_string())?;
        for &byte in chunk[..size].iter().rev() {
            if byte == b'\n' {
                if !oversized {
                    line.reverse();
                    if consume(&line) {
                        return Ok(Some(json!({"tokenUsage": usage.flatten(), "effort": effort.unwrap_or_else(|| "medium".into())})));
                    }
                }
                line.clear();
                oversized = false;
            } else if !oversized {
                if line.len() == 64 * 1024 { line.clear(); oversized = true; }
                else { line.push(byte); }
            }
        }
    }
    line.reverse();
    if !oversized { consume(&line); }
    Ok(Some(json!({"tokenUsage": usage.flatten(), "effort": effort.unwrap_or_else(|| "medium".into())})))
}

/// 区分有效用量、压缩失效标记与无关记录，仅采信原生日志数值。
fn parse_usage(line: &[u8]) -> Option<Option<Value>> {
    let value: Value = serde_json::from_slice(line).ok()?;
    if value["type"] == "compacted" { return Some(None); }
    if value["type"] != "event_msg" { return None; }
    let payload = &value["payload"];
    if payload["type"] == "context_compacted" { return Some(None); }
    if payload["type"] != "token_count" { return None; }
    let info = &payload["info"];
    let last = info["last_token_usage"]["total_tokens"].as_u64()?;
    let total = info["total_token_usage"]["total_tokens"].as_u64()?;
    Some(Some(json!({
        "last": { "totalTokens": last },
        "total": { "totalTokens": total },
        "modelContextWindow": info["model_context_window"].as_u64(),
    })))
}

/// 只读已选中的 Codex 历史文件，不扫描目录或启动会话。
#[tauri::command]
pub async fn codex_agent_read_usage(path: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_usage(Path::new(&path)))
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 验证最新记录、跨块长消息及压缩后不复用旧占比。
    #[test]
    fn latest_usage_and_compaction() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let entry = json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":4000},"total_token_usage":{"total_tokens":9000},"model_context_window":100000}}});
        writeln!(file, "{entry}").unwrap();
        writeln!(file, "{}", "x".repeat(150000)).unwrap();
        writeln!(file, "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":null}}}}").unwrap();
        let usage = read_usage(file.path()).unwrap().unwrap();
        assert_eq!(usage["tokenUsage"]["last"]["totalTokens"], 4000);
        assert_eq!(usage["tokenUsage"]["modelContextWindow"], 100000);
        assert_eq!(usage["effort"], "medium");
        writeln!(file, "{{\"type\":\"turn_context\",\"payload\":{{\"effort\":\"high\"}}}}").unwrap();
        writeln!(file, "{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"test\"}}}}").unwrap();
        writeln!(file, "{{\"type\":\"compacted\"}}").unwrap();
        let history = read_usage(file.path()).unwrap().unwrap();
        assert!(history["tokenUsage"].is_null());
        assert_eq!(history["effort"], "high");
    }
}
