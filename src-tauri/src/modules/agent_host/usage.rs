//! Incremental, read-only ingestion of native agent usage records.
use super::{history, metadata};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

fn open(directory: &Path) -> Result<Connection, String> {
    let conn = Connection::open(directory.join("codev.sqlite3")).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_usage_records (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL, reported_cost REAL, duration_ms INTEGER, first_token_ms INTEGER);
        CREATE INDEX IF NOT EXISTS idx_agent_usage_time ON agent_usage_records(timestamp);
        CREATE TABLE IF NOT EXISTS agent_usage_cursors (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL, offset INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_usage_prices (
        model TEXT PRIMARY KEY, input REAL NOT NULL, output REAL NOT NULL,
        cache_read REAL NOT NULL, cache_write REAL NOT NULL);").map_err(|e| e.to_string())?;
    // Reference rates per million tokens, based on CC Switch's model pricing table.
    for (model, input, output, cache_read, cache_write) in [
        ("gpt-6.1-terra", 1.0, 5.0, 0.05, 1.25),
        ("gpt-6.1-sol", 2.0, 10.0, 0.10, 2.50),
        ("gpt-6.2-sol", 2.0, 10.0, 0.10, 2.50),
        ("gpt-6.2-astra", 8.0, 40.0, 0.40, 10.0),
        ("gpt-6-astra", 10.0, 50.0, 1.0, 12.5),
        ("gpt-6-sol", 2.0, 10.0, 0.20, 2.50),
        ("gpt-6-luna", 0.10, 0.50, 0.01, 0.125),
        ("gpt-5.4", 2.50, 15.0, 0.25, 0.0),
    ] {
        conn.execute("INSERT OR IGNORE INTO agent_usage_prices(model,input,output,cache_read,cache_write) VALUES(?1,?2,?3,?4,?5)", params![model,input,output,cache_read,cache_write]).map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

fn files(root: &Path, depth: usize, agy: bool, out: &mut Vec<PathBuf>, errors: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            errors.push(format!("{}: {e}", root.display()));
            return;
        }
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            files(&path, depth - 1, agy, out, errors);
        } else if kind.is_file()
            && if agy {
                entry.file_name() == "transcript_full.jsonl"
            } else {
                path.extension().is_some_and(|v| v == "jsonl")
            }
        {
            out.push(path);
        }
    }
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}
fn cached_tokens(value: &Value) -> i64 {
    value
        .get("cached_input_tokens")
        .or_else(|| value.get("cache_read_input_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0)
}
fn label(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .chars()
        .take(256)
        .collect()
}
fn timestamp(value: &Value) -> i64 {
    let raw = value.get("timestamp").or_else(|| value.get("created_at"));
    (history::parse_timestamp_ms(raw) / 1000) as i64
}

fn process(conn: &mut Connection, path: &Path, source: &str) -> Result<usize, String> {
    let path_text = metadata::display_path(path);
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_millis() as i64)
        .unwrap_or(0);
    let previous: Option<(u64, i64, u64, String)> = conn
        .query_row(
            "SELECT size,modified,offset,state FROM agent_usage_cursors WHERE path=?1",
            [&path_text],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if previous
        .as_ref()
        .is_some_and(|v| v.0 == size && v.1 == modified)
    {
        return Ok(0);
    }
    let resume = previous.as_ref().filter(|v| size > v.0 && source != "agy");
    let offset = resume.map(|v| v.2).unwrap_or(0);
    let mut state: Value = resume
        .and_then(|v| serde_json::from_str(&v.3).ok())
        .unwrap_or_else(|| json!({}));
    let mut reader = BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut position = offset;
    let mut count = 0;
    loop {
        let mut bytes = Vec::new();
        let n = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if n == 0 || bytes.last() != Some(&b'\n') {
            break;
        }
        let line_pos = position;
        position += n as u64;
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if source == "codex" && kind == "session_meta" {
            state["session"] = v.pointer("/payload/id").cloned().unwrap_or(Value::Null);
        } else if source == "pi" && kind == "session" {
            state["session"] = v.get("id").cloned().unwrap_or(Value::Null);
        }
        if source == "codex" && kind == "turn_context" {
            if let Some(model) = v
                .pointer("/payload/model")
                .or_else(|| v.pointer("/payload/info/model"))
            {
                state["model"] = model.clone();
            }
        }
        if source == "codex" && kind == "token_usage_record" {
            state["pending_usage"] = v.pointer("/payload/usage").cloned().unwrap_or(Value::Null);
        }
        if source == "codex"
            && v.pointer("/payload/type").and_then(Value::as_str) == Some("thread_settings_applied")
        {
            if let Some(model) = v.pointer("/payload/thread_settings/model") {
                state["model"] = model.clone();
            }
        }
        if source == "agy" && kind == "USER_INPUT" {
            if let Some(content) = v.get("content").and_then(Value::as_str) {
                if let Some((_, rest)) = content.split_once("Model Selection") {
                    if let Some((_, model)) = rest.split_once(" to ") {
                        let model = model.split(". ").next().unwrap_or(model);
                        let model = model
                            .split(['\n', '`'])
                            .next()
                            .unwrap_or(model)
                            .trim()
                            .trim_matches('.')
                            .trim();
                        if !model.is_empty() && !model.eq_ignore_ascii_case("none") {
                            state["model"] = json!(model);
                        }
                    }
                }
            }
        }
        let session = label(state.get("session"), "");
        let session = if session.is_empty() {
            if source == "agy" {
                path.ancestors()
                    .nth(3)
                    .and_then(Path::file_name)
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
            } else {
                path_text.clone()
            }
        } else {
            session
        };
        let mut reported_cost = None;
        let mut duration = None;
        let mut first_token = None;
        if source == "codex" {
            let event_time = history::parse_timestamp_ms(v.get("timestamp"));
            let payload_type = v
                .pointer("/payload/type")
                .and_then(Value::as_str)
                .unwrap_or("");
            if event_time > 0
                && (kind == "turn_context"
                    || matches!(
                        payload_type,
                        "task_started" | "function_call_output" | "custom_tool_call_output"
                    ))
            {
                state["request_start"] = json!(event_time);
                state["first_output"] = Value::Null;
            }
            if kind == "event_msg"
                && payload_type == "item_completed"
                && matches!(
                    v.pointer("/payload/item/type").and_then(Value::as_str),
                    Some("Reasoning" | "AgentMessage")
                )
            {
                if let Some(started) = v.pointer("/payload/started_at_ms").and_then(Value::as_u64) {
                    let earliest = state
                        .get("first_output")
                        .and_then(Value::as_u64)
                        .map_or(started, |old| old.min(started));
                    state["first_output"] = json!(earliest);
                }
            }
        }
        let (input, output, cache, write, model, provider, id) = match source {
            "pi" if kind == "message"
                && v.pointer("/message/role").and_then(Value::as_str) == Some("assistant") =>
            {
                let Some(usage) = v.pointer("/message/usage") else {
                    continue;
                };
                let msg = &v["message"];
                reported_cost = usage
                    .pointer("/cost/total")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v > 0.0);
                let start = history::parse_timestamp_ms(msg.get("timestamp"));
                let end = history::parse_timestamp_ms(v.get("timestamp"));
                if end > start && start > 0 {
                    duration = Some((end - start) as i64);
                }
                (
                    number(usage, "input"),
                    number(usage, "output"),
                    number(usage, "cacheRead"),
                    number(usage, "cacheWrite"),
                    label(msg.get("model"), "未知"),
                    label(msg.get("provider"), "Pi 会话日志"),
                    format!("pi:{session}:{}", label(v.get("id"), &line_pos.to_string())),
                )
            }
            "codex"
                if v.pointer("/payload/type").and_then(Value::as_str) == Some("token_count") =>
            {
                let Some(info) = v.pointer("/payload/info") else {
                    continue;
                };
                let total = info.get("total_token_usage").filter(|x| x.is_object());
                let last = info.get("last_token_usage").filter(|x| x.is_object());
                let pending_usage = state.get("pending_usage").cloned().unwrap_or(Value::Null);
                state["pending_usage"] = Value::Null;
                if total.is_none() && last.is_none() {
                    continue;
                }
                let signature = json!([total, last]).to_string();
                let lane = v
                    .pointer("/payload/rate_limits/limit_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let repeated = total.is_some()
                    && state
                        .pointer("/signatures")
                        .and_then(|v| v.get(lane))
                        .and_then(Value::as_str)
                        == Some(signature.as_str());
                if total.is_some() {
                    if !state.get("signatures").is_some_and(Value::is_object) {
                        state["signatures"] = json!({});
                    }
                    state["signatures"][lane] = json!(signature);
                }
                let last_is_zero = last.is_some_and(|v| {
                    number(v, "input_tokens") == 0
                        && number(v, "output_tokens") == 0
                        && cached_tokens(v) == 0
                        && number(v, "cache_write_input_tokens") == 0
                });
                let last = if last_is_zero && pending_usage.is_object() {
                    Some(&pending_usage)
                } else {
                    last
                };
                if repeated && !last_is_zero {
                    continue;
                }
                let old = state.get("total").cloned().unwrap_or_else(|| json!({}));
                let delta = |key: &str| {
                    let read = |v: &Value| {
                        if key == "cached_input_tokens" {
                            cached_tokens(v)
                        } else {
                            number(v, key)
                        }
                    };
                    last.map(read)
                        .unwrap_or_else(|| total.map(read).unwrap_or(0).saturating_sub(read(&old)))
                };
                let (all, out, hit, written) = (
                    delta("input_tokens"),
                    delta("output_tokens"),
                    delta("cached_input_tokens"),
                    delta("cache_write_input_tokens"),
                );
                if let Some(total) = total {
                    let mut high = old;
                    for key in ["input_tokens", "output_tokens", "cache_write_input_tokens"] {
                        high[key] = json!(number(&high, key).max(number(total, key)));
                    }
                    high["cached_input_tokens"] =
                        json!(cached_tokens(&high).max(cached_tokens(total)));
                    state["total"] = high;
                }
                let end = history::parse_timestamp_ms(v.get("timestamp"));
                if let Some(start) = state
                    .get("request_start")
                    .and_then(Value::as_u64)
                    .filter(|start| *start > 0 && end > *start)
                {
                    duration = Some((end - start) as i64);
                    first_token = state
                        .get("first_output")
                        .and_then(Value::as_u64)
                        .filter(|first| *first >= start && *first <= end)
                        .map(|first| (first - start) as i64);
                }
                state["request_start"] = json!(end);
                state["first_output"] = Value::Null;
                let file_name = path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let hit = hit.min(all);
                let written = written.min(all - hit);
                (
                    all - hit - written,
                    out,
                    hit,
                    written,
                    label(
                        info.get("model")
                            .or_else(|| info.get("model_name"))
                            .or_else(|| v.pointer("/payload/model"))
                            .or_else(|| state.get("model")),
                        "未知",
                    ),
                    "Codex 会话日志".into(),
                    format!("codex:{session}:{file_name}:{line_pos}"),
                )
            }
            "agy"
                if kind == "PLANNER_RESPONSE"
                    && v.get("status").and_then(Value::as_str) == Some("DONE") =>
            {
                let Some(step) = v.get("step_index").and_then(Value::as_u64) else {
                    continue;
                };
                (
                    number(&v, "input_tokens"),
                    number(&v, "output_tokens"),
                    number(&v, "cache_read_tokens"),
                    number(&v, "cache_write_tokens"),
                    label(v.get("model").or_else(|| state.get("model")), "未知"),
                    "Antigravity 会话日志".into(),
                    format!("agy:{session}:{step}"),
                )
            }
            _ => continue,
        };
        if input == 0 && output == 0 && cache == 0 && write == 0 && reported_cost.is_none() {
            continue;
        }
        tx.execute("INSERT INTO agent_usage_records(id,source,session_id,timestamp,provider,model,input,output,cache_read,cache_write,reported_cost,duration_ms,first_token_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,provider=excluded.provider,model=excluded.model,input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,reported_cost=excluded.reported_cost,duration_ms=excluded.duration_ms,first_token_ms=excluded.first_token_ms",
            params![id, source, session, timestamp(&v), provider, model, input, output, cache, write, reported_cost, duration, first_token]).map_err(|e| e.to_string())?;
        count += 1;
    }
    tx.execute("INSERT INTO agent_usage_cursors(path,size,modified,offset,state) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified,offset=excluded.offset,state=excluded.state",params![path_text,size,modified,position,state.to_string()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

pub fn sync(directory: &Path) -> Result<Value, String> {
    let mut conn = open(directory)?;
    let mut sources: Vec<(&str, PathBuf, usize, bool)> = Vec::new();
    if let Some(home) = history::pi_home() {
        sources.push(("pi", home.join("sessions"), 8, false));
    }
    if let Some(home) = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
    {
        sources.push(("codex", home.join("sessions"), 9, false));
        sources.push(("codex", home.join("archived_sessions"), 9, false));
    }
    if let Some(home) = dirs::home_dir() {
        sources.push(("agy", home.join(".gemini/antigravity-cli/brain"), 6, true));
        sources.push(("agy", home.join(".gemini/antigravity/brain"), 6, true));
    }
    let mut errors = Vec::new();
    let mut count = 0;
    let mut scanned = 0;
    for (source, root, depth, agy) in sources {
        let mut found = Vec::new();
        files(&root, depth, agy, &mut found, &mut errors);
        for path in found {
            scanned += 1;
            match process(&mut conn, &path, source) {
                Ok(n) => count += n,
                Err(e) => errors.push(format!("{}: {e}", path.display())),
            }
        }
    }
    Ok(
        json!({"updated": count, "files": scanned, "errors": errors, "syncedAt": super::protocol::now()}),
    )
}

pub fn save_price(directory: &Path, value: &Value) -> Result<Value, String> {
    let model = label(value.get("model"), "");
    if model.is_empty() {
        return Err("请填写模型名称".into());
    }
    let price = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(|| format!("{key} 价格无效"))
    };
    let conn = open(directory)?;
    conn.execute("INSERT INTO agent_usage_prices(model,input,output,cache_read,cache_write) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(model) DO UPDATE SET input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write",params![model,price("input")?,price("output")?,price("cacheRead")?,price("cacheWrite")?]).map_err(|e| e.to_string())?;
    Ok(json!({"saved":true}))
}

pub fn query(directory: &Path, options: &Value) -> Result<Value, String> {
    let conn = open(directory)?;
    let start = options.get("start").and_then(Value::as_i64).unwrap_or(0);
    let end = options
        .get("end")
        .and_then(Value::as_i64)
        .unwrap_or(i64::MAX);
    let source = options.get("source").and_then(Value::as_str).unwrap_or("");
    let model = options.get("model").and_then(Value::as_str).unwrap_or("");
    let provider = options
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let page = options
        .get("page")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 100000);
    let where_clause = "r.timestamp >= ?1 AND r.timestamp < ?2 AND (?3='' OR r.source=?3) AND (?4='' OR r.model=?4) AND (?5='' OR r.provider=?5)";
    let cost = "COALESCE(r.reported_cost,CASE WHEN p.model IS NOT NULL THEN (r.input*p.input+r.output*p.output+r.cache_read*p.cache_read+r.cache_write*p.cache_write)/1000000.0 END)";
    let base = "FROM agent_usage_records r LEFT JOIN agent_usage_prices p ON p.model=r.model";
    let args = params![start, end, source, model, provider];
    let sql = format!("SELECT COUNT(*),COALESCE(SUM(r.input),0),COALESCE(SUM(r.output),0),COALESCE(SUM(r.cache_read),0),COALESCE(SUM(r.cache_write),0),SUM({cost}),SUM(CASE WHEN {cost} IS NULL THEN 1 ELSE 0 END) {base} WHERE {where_clause}");
    let totals = conn.query_row(&sql, args, |r| Ok(json!({"requests":r.get::<_,i64>(0)?,"input":r.get::<_,i64>(1)?,"output":r.get::<_,i64>(2)?,"cacheRead":r.get::<_,i64>(3)?,"cacheWrite":r.get::<_,i64>(4)?,"cost":r.get::<_,Option<f64>>(5)?,"unpriced":r.get::<_,Option<i64>>(6)?.unwrap_or(0)}))).map_err(|e| e.to_string())?;
    let sql = format!("SELECT r.timestamp,r.source,r.provider,r.model,r.input,r.output,r.cache_read,r.cache_write,{cost},r.duration_ms,r.first_token_ms {base} WHERE {where_clause} ORDER BY r.timestamp DESC LIMIT 50 OFFSET ?6");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![start,end,source,model,provider,page*50],|r|Ok(json!({"timestamp":r.get::<_,i64>(0)?,"source":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"model":r.get::<_,String>(3)?,"input":r.get::<_,i64>(4)?,"output":r.get::<_,i64>(5)?,"cacheRead":r.get::<_,i64>(6)?,"cacheWrite":r.get::<_,i64>(7)?,"cost":r.get::<_,Option<f64>>(8)?,"durationMs":r.get::<_,Option<i64>>(9)?,"firstTokenMs":r.get::<_,Option<i64>>(10)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let interval = if options.get("interval").and_then(Value::as_str) == Some("hour") {
        3600i64
    } else {
        86400i64
    };
    let zone = options
        .get("timezoneOffset")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(-86400, 86400);
    let sql = format!("SELECT ((r.timestamp+?6)/?7)*?7-?6, SUM(r.input+r.output+r.cache_read+r.cache_write), SUM({cost}), COUNT(*) {base} WHERE {where_clause} GROUP BY 1 ORDER BY 1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let points = stmt.query_map(params![start,end,source,model,provider,zone,interval],|r|Ok(json!({"timestamp":r.get::<_,i64>(0)?,"tokens":r.get::<_,i64>(1)?,"cost":r.get::<_,Option<f64>>(2)?,"requests":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let groups = |field: &str| -> Result<Vec<Value>, String> {
        let sql = format!("SELECT {field},COUNT(*),SUM(r.input+r.output+r.cache_read+r.cache_write),SUM({cost}) {base} WHERE {where_clause} GROUP BY {field} ORDER BY 2 DESC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let result = stmt.query_map(params![start,end,source,model,provider],|r|Ok(json!({"name":r.get::<_,String>(0)?,"requests":r.get::<_,i64>(1)?,"tokens":r.get::<_,i64>(2)?,"cost":r.get::<_,Option<f64>>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        Ok(result)
    };
    let providers = groups("r.provider")?;
    let models = groups("r.model")?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT model,provider,source FROM agent_usage_records ORDER BY model")
        .map_err(|e| e.to_string())?;
    let options = stmt.query_map([],|r|Ok(json!({"model":r.get::<_,String>(0)?,"provider":r.get::<_,String>(1)?,"source":r.get::<_,String>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut stmt = conn.prepare("SELECT model,input,output,cache_read,cache_write FROM agent_usage_prices ORDER BY model").map_err(|e|e.to_string())?;
    let prices = stmt.query_map([],|r|Ok(json!({"model":r.get::<_,String>(0)?,"input":r.get::<_,f64>(1)?,"output":r.get::<_,f64>(2)?,"cacheRead":r.get::<_,f64>(3)?,"cacheWrite":r.get::<_,f64>(4)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(
        json!({"totals":totals,"rows":rows,"points":points,"providers":providers,"models":models,"options":options,"prices":prices}),
    )
}
