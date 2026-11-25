//! ACP lifecycle and message normalization. No model-provider injection into Pi.
use super::{
    antigravity_history,
    bridge::lock,
    coordinator::{Host, Runtime},
    history,
    protocol::*,
};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
const TIMEOUT: Duration = Duration::from_secs(120);
const REPLAY_IDLE_GAP: Duration = Duration::from_millis(2000);
const TOOL_TEXT_LIMIT: usize = 8_000;
const TOOL_PAYLOAD_MAX_NODES: usize = 512;
const TOOL_PAYLOAD_MAX_TEXT: usize = 64_000;
const TOOL_TEXT_TRUNCATED: &str = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED: &str = "\n\n[Command truncated]";

fn parse_semver3(version: &str) -> Option<(u32, u32, u32)> {
    let trimmed = version.trim().trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = trimmed.split(['.', '-', '+']);
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    Some((major, minor, patch))
}

fn detect_agy_cli_version() -> Option<(u32, u32, u32)> {
    static VERSION: OnceLock<Option<(u32, u32, u32)>> = OnceLock::new();
    *VERSION.get_or_init(|| {
        let bin = super::registry::resolve_binary("agy")?;
        let mut cmd = super::registry::command_for(&bin, &["--version".to_string()]);
        let output = cmd.output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        parse_semver3(&stdout).or_else(|| parse_semver3(&stderr))
    })
}

fn antigravity_client_info(cli_version: Option<(u32, u32, u32)>) -> Value {
    // agy >= 1.5.1 exposes every model to any clientInfo; older 1.3/1.4/1.5.0 builds allowlist Zed.
    if cli_version.is_some_and(|v| v < (1, 5, 1)) {
        json!({ "name": "zed", "version": "0.0.0" })
    } else {
        json!({ "name": "Codev", "version": env!("CARGO_PKG_VERSION") })
    }
}

pub(super) fn format_acp_error(error: &str, diagnostic: &str) -> String {
    let lower = format!("{error}\n{diagnostic}").to_ascii_lowercase();
    if lower.contains("quota_exhausted") || lower.contains("quota exceeded") || lower.contains("resource_exhausted") {
        return format!("Antigravity 模型配额已耗尽，请切换模型或稍后再试。\n{error}");
    }
    if lower.contains("invalid_thinking_signature") || lower.contains("thinking signature") {
        return format!("Antigravity 会话思考签名失效，建议新建会话继续。\n{error}");
    }
    if let Some(url) = extract_auth_url(diagnostic).or_else(|| extract_auth_url(error)) {
        return format!("{error}\n请在浏览器完成授权：{url}");
    }
    error.to_string()
}

fn extract_auth_url(text: &str) -> Option<&str> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '<' | '>' | ',' | ')' | ']'));
        if (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
            && (trimmed.contains("accounts.google.com")
                || trimmed.contains("oauth")
                || trimmed.contains("auth")
                || trimmed.contains("login"))
        {
            return Some(trimmed);
        }
    }
    None
}

fn bound_tail(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    let keep = s.chars().skip(char_count - max_chars).collect::<String>();
    format!("{TOOL_TEXT_TRUNCATED}{keep}")
}

fn bound_head(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    let keep = s.chars().take(max_chars).collect::<String>();
    format!("{keep}{COMMAND_LINE_TRUNCATED}")
}

struct SanitizeBudget {
    nodes: usize,
    text: usize,
}

fn sanitize_tool_value(
    value: &Value,
    budget: &mut SanitizeBudget,
    depth: usize,
    field: Option<&str>,
) -> Option<Value> {
    if depth > 12 || budget.nodes == 0 {
        return None;
    }
    budget.nodes -= 1;
    match value {
        Value::String(s) => {
            if s.len() >= 11 && s[..11].eq_ignore_ascii_case("data:image/") {
                return None;
            }
            if budget.text == 0 {
                return None;
            }
            let limit = TOOL_TEXT_LIMIT.min(budget.text);
            let is_cmd = matches!(
                field,
                Some("CommandLine" | "command_line" | "commandLine" | "command")
            );
            let bounded = if is_cmd {
                bound_head(s, limit)
            } else {
                bound_tail(s, limit)
            };
            let len = bounded.chars().count();
            budget.text = budget.text.saturating_sub(len);
            Some(Value::String(bounded))
        }
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                if budget.nodes == 0 {
                    break;
                }
                if let Some(cleaned) = sanitize_tool_value(item, budget, depth + 1, None) {
                    out.push(cleaned);
                }
            }
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            let is_image_obj = map.get("type").and_then(Value::as_str) == Some("image");
            let has_image_mime = map
                .get("mimeType")
                .and_then(Value::as_str)
                .is_some_and(|m| m.starts_with("image/"));
            let combined = map
                .get("combinedOutput")
                .or_else(|| map.get("combined_output"));
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if budget.nodes == 0 {
                    break;
                }
                if (is_image_obj && (k == "data" || k == "blob"))
                    || (k == "blob" && has_image_mime)
                    || ((k == "formatted_output" || k == "formattedOutput") && combined == Some(v))
                {
                    continue;
                }
                if let Some(cleaned) = sanitize_tool_value(v, budget, depth + 1, Some(k.as_str())) {
                    out.insert(k.clone(), cleaned);
                }
            }
            Some(Value::Object(out))
        }
        other => Some(other.clone()),
    }
}

pub(super) fn sanitize_acp_tool_payload(value: &Value) -> Value {
    let mut budget = SanitizeBudget {
        nodes: TOOL_PAYLOAD_MAX_NODES,
        text: TOOL_PAYLOAD_MAX_TEXT,
    };
    sanitize_tool_value(value, &mut budget, 0, None).unwrap_or(Value::Null)
}

fn extract_antigravity_update_steps(raw_input: &Value) -> Option<Vec<Value>> {
    let steps = raw_input.get("steps")?.as_array()?;
    let entries: Vec<Value> = steps
        .iter()
        .filter_map(|step| {
            let title = step.get("title").and_then(Value::as_str)?;
            let status = match step.get("status").and_then(Value::as_str) {
                Some("done") => "completed",
                Some(other) => other,
                None => "pending",
            };
            Some(json!({
                "content": title,
                "priority": "medium",
                "status": status,
            }))
        })
        .collect();
    Some(entries)
}

pub(super) fn is_antigravity_interaction_permission(params: &Value) -> bool {
    params
        .pointer("/toolCall/toolCallId")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("interaction_"))
}

/// CLI-owned credentials only. Codev never asks for or stores an agent password.
fn with_auth_hint(harness: &str, error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if !(lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || lower.contains("credential"))
    {
        return error;
    }
    let hint = match harness {
        "acp:codex" => "请在终端运行 codex login（或设置 OPENAI_API_KEY）后重新连接。",
        "acp:antigravity" => "请在 Windows CMD 运行 agy 并按提示完成 Google 登录后重新连接。",
        _ => "请先在对应的命令行程序中完成登录，再重新连接此会话。",
    };
    format!("{error}
{hint}")
}
fn recoverable_missing_session(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no rollout")
        || lower.contains("not found")
        || lower.contains("unknown session")
        || lower.contains("does not exist")
}

fn options(value: &Value) -> Vec<Value> {
    let Some(list) = value.as_array() else {
        return vec![];
    };
    list.iter()
        .flat_map(|item| {
            if let Some(group) = item.get("options").and_then(Value::as_array) {
                group.clone()
            } else {
                vec![item.clone()]
            }
        })
        .collect()
}
fn codex_effort_from_model_id(model_id: &str) -> Option<String> {
    let suffix = model_id
        .rsplit_once('/')
        .map(|(_, e)| e.trim().to_ascii_lowercase())?;
    matches!(
        suffix.as_str(),
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    )
    .then_some(suffix)
}

fn collect_codex_thinking_levels(
    available_models: Option<&[Value]>,
    current_model_id: Option<&str>,
) -> Vec<String> {
    let base_filter = current_model_id
        .map(|m| m.split('/').next().unwrap_or(m).trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let mut matched = Vec::new();
    let mut all = Vec::new();
    if let Some(list) = available_models {
        for item in list {
            let mid = text(item, "modelId");
            if let Some(effort) = codex_effort_from_model_id(&mid) {
                let item_base = mid.split('/').next().unwrap_or("").trim().to_ascii_lowercase();
                if base_filter.as_deref() == Some(item_base.as_str())
                    && !matched.contains(&effort)
                {
                    matched.push(effort.clone());
                }
                if !all.contains(&effort) {
                    all.push(effort);
                }
            }
        }
    }
    if matched.len() > 1 {
        return matched;
    }
    if all.len() > 1 {
        return all;
    }
    ["low", "medium", "high", "xhigh"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn ensure_codex_thinking_defaults(
    view: &mut SessionView,
    available_models: Option<&[Value]>,
    current_model_id: Option<&str>,
) {
    if view.binding.harness_id != "acp:codex" {
        return;
    }
    if view.thinking_levels.is_empty() {
        let current_or_view = current_model_id.map(str::to_string).or_else(|| {
            view.model
                .as_ref()
                .map(|m| text(m, "id"))
                .filter(|s| !s.is_empty())
        });
        view.thinking_levels =
            collect_codex_thinking_levels(available_models, current_or_view.as_deref());
    }
    if view.thinking_level.is_empty() || !view.thinking_levels.contains(&view.thinking_level) {
        let from_model = current_model_id.and_then(codex_effort_from_model_id);
        let from_pref = view.binding.preferences.thinking_level.clone();
        if let Some(level) = from_model.filter(|l| view.thinking_levels.contains(l)) {
            view.thinking_level = level;
        } else if let Some(level) = from_pref.filter(|l| view.thinking_levels.contains(l)) {
            view.thinking_level = level;
        } else if view.thinking_levels.iter().any(|l| l == "medium") {
            view.thinking_level = "medium".into();
        } else if let Some(first) = view.thinking_levels.first() {
            view.thinking_level = first.clone();
        }
    }
    view.capabilities.supports_thinking = view.thinking_levels.len() > 1;
}

fn apply_config(view: &mut SessionView, config: Vec<Value>) {
    apply_config_with_models(view, config, None, None);
}

fn apply_config_with_models(
    view: &mut SessionView,
    mut config: Vec<Value>,
    available_models: Option<&[Value]>,
    current_model_id: Option<&str>,
) {
    let has_mode = config
        .iter()
        .any(|o| text(o, "id") == "$mode" || text(o, "category") == "mode");
    if !has_mode {
        if let Some(existing_mode) = view
            .config_options
            .iter()
            .find(|o| text(o, "id") == "$mode" || text(o, "category") == "mode")
            .cloned()
        {
            config.push(existing_mode);
        }
    }
    for option in &config {
        let category = text(option, "category");
        let id = text(option, "id");
        let current = text(option, "currentValue");
        let choices = options(option.get("options").unwrap_or(&Value::Null));
        if category == "model" || id == "model" {
            view.models=choices.iter().map(|v|json!({"id":v.get("value"),"name":v.get("name").or_else(||v.get("label")),"provider":view.binding.harness_id,"configId":id})).collect();
            view.model = view
                .models
                .iter()
                .find(|v| text(v, "id") == current)
                .cloned()
                .or_else(|| {
                    (!current.is_empty()).then(|| {
                        json!({
                            "id": current,
                            "name": current,
                            "provider": view.binding.harness_id,
                            "configId": id,
                        })
                    })
                });
            view.capabilities.supports_model_selection = !view.models.is_empty();
        }
        if matches!(category.as_str(), "thought_level" | "thinking")
            || id.contains("thinking")
            || id == "thought_level"
        {
            view.thinking_levels = choices
                .iter()
                .filter_map(|v| v.get("value").and_then(Value::as_str).map(str::to_string))
                .collect();
            view.thinking_level = current;
            view.capabilities.supports_thinking = view.thinking_levels.len() > 1;
        }
    }
    view.config_options = config;
    ensure_codex_thinking_defaults(view, available_models, current_model_id);
}
#[derive(Debug, PartialEq, Eq)]
enum AcpModelResolution {
    ConfigValue(String),
    AvailableModel {
        model_id: String,
        base_value: Option<String>,
        thought_level: Option<String>,
    },
}

fn strip_models_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    trimmed.strip_prefix("models/").unwrap_or(trimmed)
}

fn split_tiered_model(
    candidate: &str,
    view_models: &[Value],
) -> (Option<String>, Option<String>) {
    let lower = candidate.to_ascii_lowercase();
    let best = view_models
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .filter(|id| lower == id.to_ascii_lowercase() || lower.starts_with(&format!("{}-", id.to_ascii_lowercase())))
        .max_by_key(|id| id.len())
        .map(str::to_string);
    let tier = best.as_ref().and_then(|base| {
        if lower.len() > base.len() + 1 {
            Some(lower[base.len() + 1..].to_string())
        } else {
            None
        }
    });
    (best, tier)
}

fn resolve_acp_model(
    configured: &str,
    view_models: &[Value],
    available_models: Option<&[Value]>,
) -> Option<AcpModelResolution> {
    let target = strip_models_prefix(configured);
    if target.is_empty() {
        return None;
    }
    if let Some(found) = view_models.iter().find(|m| text(m, "id") == target) {
        return Some(AcpModelResolution::ConfigValue(text(found, "id")));
    }
    if let Some(found) = view_models
        .iter()
        .find(|m| text(m, "id").eq_ignore_ascii_case(target) || text(m, "name").eq_ignore_ascii_case(target))
    {
        return Some(AcpModelResolution::ConfigValue(text(found, "id")));
    }
    if let Some(available) = available_models {
        if let Some(found) = available.iter().find(|m| {
            let mid = text(m, "modelId");
            let name = text(m, "name");
            mid == target || mid.eq_ignore_ascii_case(target) || name.eq_ignore_ascii_case(target)
        }) {
            let model_id = text(found, "modelId");
            let (base_value, thought_level) = split_tiered_model(&model_id, view_models);
            return Some(AcpModelResolution::AvailableModel {
                model_id,
                base_value,
                thought_level,
            });
        }
    }
    if let (Some(base_value), Some(thought_level)) = split_tiered_model(target, view_models) {
        return Some(AcpModelResolution::AvailableModel {
            model_id: target.to_string(),
            base_value: Some(base_value),
            thought_level: Some(thought_level),
        });
    }
    if let Some((base_part, tier_part)) = target.rsplit_once(" (").and_then(|(b, r)| r.strip_suffix(')').map(|t| (b.trim(), t.trim().to_ascii_lowercase()))) {
        if let Some(found) = view_models
            .iter()
            .find(|m| text(m, "name").eq_ignore_ascii_case(base_part) || text(m, "id").eq_ignore_ascii_case(base_part))
        {
            let base = text(found, "id");
            return Some(AcpModelResolution::AvailableModel {
                model_id: format!("{base}-{tier_part}"),
                base_value: Some(base),
                thought_level: Some(tier_part),
            });
        }
    }
    None
}

fn apply_provider_scope_to_view(
    view: &mut SessionView,
    provider_label: &str,
    configured_models: Option<&[String]>,
    available_models: Option<&[Value]>,
) {
    if view.binding.harness_id == "acp:antigravity" {
        if let Some(configured) = configured_models {
            let mut allowed_ids: Vec<String> = Vec::new();
            for entry in configured {
                let matched = match resolve_acp_model(entry, &view.models, available_models) {
                    Some(AcpModelResolution::ConfigValue(id)) => Some(id),
                    Some(AcpModelResolution::AvailableModel { base_value: Some(id), .. }) => Some(id),
                    Some(AcpModelResolution::AvailableModel { model_id, .. }) => view
                        .models
                        .iter()
                        .find(|m| text(m, "id") == model_id)
                        .map(|m| text(m, "id")),
                    None => None,
                };
                if let Some(id) = matched {
                    if !allowed_ids.contains(&id) {
                        allowed_ids.push(id);
                    }
                }
            }
            if !allowed_ids.is_empty() {
                view.models.retain(|m| allowed_ids.iter().any(|id| id == &text(m, "id")));
            }
        }
    }
    for model in &mut view.models {
        if let Some(obj) = model.as_object_mut() {
            obj.insert("provider".into(), json!(provider_label));
        }
    }
    if let Some(obj) = view.model.as_mut().and_then(Value::as_object_mut) {
        obj.insert("provider".into(), json!(provider_label));
    }
}

fn apply_session(view: &mut SessionView, response: &Value) {
    if let Some(commands) = response.get("availableCommands").and_then(Value::as_array) {
        view.commands = commands.clone();
        view.capabilities.supports_skills = !commands.is_empty();
    }
    if let Some(models) = response.get("models") {
        view.models=models.get("availableModels").and_then(Value::as_array).map(|models|models.iter().map(|m|json!({"id":m.get("modelId"),"name":m.get("name"),"provider":view.binding.harness_id})).collect()).unwrap_or_default();
        view.model = view
            .models
            .iter()
            .find(|m| m.get("id") == models.get("currentModelId"))
            .cloned();
        view.capabilities.supports_model_selection = !view.models.is_empty();
    }
    let mut config = response
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if response.get("modes").is_some() {
        // The dedicated `modes` field is the authoritative permission selector.
        config.retain(|option| text(option, "id") != "mode" && text(option, "category") != "mode");
    }
    if let Some(modes) = response.get("modes") {
        config.push(json!({"id":"$mode","name":"权限模式","category":"mode","type":"select","currentValue":modes.get("currentModeId"),"options":modes.get("availableModes").and_then(Value::as_array).map(|list|list.iter().map(|m|json!({"value":m.get("id"),"name":m.get("name")})).collect::<Vec<_>>()).unwrap_or_default()}));
    }
    let available = response
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    let current_model = response
        .pointer("/models/currentModelId")
        .and_then(Value::as_str);
    if !config.is_empty() {
        apply_config_with_models(view, config, available, current_model);
    } else {
        ensure_codex_thinking_defaults(view, available, current_model);
    }
}
#[cfg(test)]
pub(super) fn apply_session_for_test(view: &mut SessionView, response: &Value) {
    apply_session(view, response);
}
fn permission_option_id(option: &Value) -> String {
    option
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| text(option, "optionId"))
}

fn pick_permission_option(options: &[Value], allow: bool) -> Option<String> {
    if allow {
        for target_kind in ["allow_once", "allow_always"] {
            if let Some(opt) = options
                .iter()
                .find(|item| text(item, "kind") == target_kind && !permission_option_id(item).is_empty())
            {
                return Some(permission_option_id(opt));
            }
        }
        if let Some(opt) = options.iter().find(|item| {
            let id = permission_option_id(item);
            let kind = text(item, "kind").to_ascii_lowercase();
            let name = text(item, "name").to_ascii_lowercase();
            !id.is_empty()
                && (kind.starts_with("allow")
                    || id.to_ascii_lowercase().starts_with("allow")
                    || name.contains("allow")
                    || name.contains("允许")
                    || name.contains("批准"))
        }) {
            return Some(permission_option_id(opt));
        }
        return options
            .iter()
            .find(|item| {
                let id = permission_option_id(item);
                let kind = text(item, "kind").to_ascii_lowercase();
                let name = text(item, "name").to_ascii_lowercase();
                !id.is_empty()
                    && !kind.starts_with("reject")
                    && !id.eq_ignore_ascii_case("reject")
                    && !id.eq_ignore_ascii_case("deny")
                    && !name.contains("deny")
                    && !name.contains("拒绝")
            })
            .map(permission_option_id);
    }

    for target_kind in ["reject_once", "reject_always"] {
        if let Some(opt) = options
            .iter()
            .find(|item| text(item, "kind") == target_kind && !permission_option_id(item).is_empty())
        {
            return Some(permission_option_id(opt));
        }
    }
    options
        .iter()
        .find(|item| {
            let id = permission_option_id(item);
            let kind = text(item, "kind").to_ascii_lowercase();
            let name = text(item, "name").to_ascii_lowercase();
            !id.is_empty()
                && (kind.starts_with("reject")
                    || id.eq_ignore_ascii_case("reject")
                    || id.eq_ignore_ascii_case("deny")
                    || name.contains("deny")
                    || name.contains("拒绝"))
        })
        .map(permission_option_id)
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| *c != '_')
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn is_read_only_permission_tool(tool: &Value) -> bool {
    let kind = text(tool, "kind").to_ascii_lowercase();
    if matches!(kind.as_str(), "read" | "search" | "fetch") {
        return true;
    }
    if matches!(
        kind.as_str(),
        "edit" | "write" | "delete" | "move" | "execute" | "command" | "bash" | "shell"
    ) {
        return false;
    }
    let title = text(tool, "title").to_ascii_lowercase();
    if [
        "edit", "write", "delete", "remove", "command", "run ", "exec", "shell", "bash", "patch",
    ]
    .iter()
    .any(|word| title.contains(word))
    {
        return false;
    }
    let Some(raw) = tool.get("rawInput").and_then(Value::as_object) else {
        return false;
    };
    let has_mutating = raw.keys().any(|k| {
        matches!(
            normalize_key(k).as_str(),
            "content"
                | "edits"
                | "oldtext"
                | "newtext"
                | "oldstring"
                | "newstring"
                | "replacement"
                | "command"
                | "commandline"
                | "cmd"
                | "script"
                | "code"
                | "patch"
                | "diff"
                | "overwrite"
        )
    });
    if has_mutating {
        return false;
    }
    raw.keys().any(|k| {
        matches!(
            normalize_key(k).as_str(),
            "path" | "filepath" | "targetfile" | "directory" | "dir" | "pattern" | "query" | "glob" | "url"
        )
    })
}

fn resolve_permission_auto_reply(policy: &HostToolsPolicy, params: &Value) -> Option<Value> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let allow = match policy.permission.as_str() {
        "allow_all" => Some(true),
        "allow_read" => params
            .get("toolCall")
            .is_some_and(is_read_only_permission_tool)
            .then_some(true),
        "deny" => Some(false),
        _ => None,
    }?;
    match pick_permission_option(options, allow) {
        Some(option_id) => Some(json!({ "outcome": "selected", "optionId": option_id })),
        None if !allow => Some(json!({ "outcome": "cancelled" })),
        None => None,
    }
}

pub(super) fn merge_acp_usage_update(existing: &Value, update: &Value) -> Value {
    let mut map = existing.as_object().cloned().unwrap_or_default();
    if let Some(obj) = update.as_object() {
        for (key, value) in obj {
            map.insert(key.clone(), value.clone());
        }
    }
    let tokens = update
        .get("tokens")
        .or_else(|| update.get("used"))
        .and_then(Value::as_u64)
        .or_else(|| map.get("tokens").or_else(|| map.get("used")).and_then(Value::as_u64));
    let window = update
        .get("window")
        .or_else(|| update.get("size"))
        .and_then(Value::as_u64)
        .or_else(|| map.get("window").or_else(|| map.get("size")).and_then(Value::as_u64));
    if let Some(tokens) = tokens {
        map.insert("tokens".into(), json!(tokens));
        map.insert("used".into(), json!(tokens));
    }
    if let Some(window) = window {
        map.insert("window".into(), json!(window));
        map.insert("size".into(), json!(window));
    }
    let explicit_percent = update.get("percent").and_then(Value::as_f64).filter(|v| v.is_finite());
    if let Some(percent) = explicit_percent.or_else(|| {
        match (tokens, window) {
            (Some(used), Some(size)) if size > 0 => Some((used as f64 / size as f64) * 100.0),
            _ => None,
        }
    }) {
        map.insert("percent".into(), json!(percent.clamp(0.0, 100.0)));
    }
    Value::Object(map)
}

pub(super) fn merge_acp_prompt_usage(existing: &Value, reply_usage: &Value) -> Value {
    let mut map = existing.as_object().cloned().unwrap_or_default();
    let input = reply_usage
        .get("inputTokens")
        .or_else(|| reply_usage.get("input"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = reply_usage
        .get("outputTokens")
        .or_else(|| reply_usage.get("output"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = reply_usage
        .get("cachedReadTokens")
        .or_else(|| reply_usage.get("cacheRead"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = reply_usage
        .get("cachedWriteTokens")
        .or_else(|| reply_usage.get("cacheWrite"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let thought = reply_usage
        .get("thoughtTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total = reply_usage
        .get("totalTokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| input + output + cache_read + cache_write + thought);
    map.insert(
        "usage".into(),
        json!({
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
        }),
    );
    let existing_tokens = map
        .get("tokens")
        .or_else(|| map.get("used"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if existing_tokens == 0 && total > 0 {
        map.insert("tokens".into(), json!(total));
        map.insert("used".into(), json!(total));
        if let Some(window) = map
            .get("window")
            .or_else(|| map.get("size"))
            .and_then(Value::as_u64)
            .filter(|w| *w > 0)
        {
            map.insert("percent".into(), json!(((total as f64 / window as f64) * 100.0).clamp(0.0, 100.0)));
        }
    }
    Value::Object(map)
}

impl Host {
    pub async fn initialize_acp(
        self: &Arc<Self>,
        id: &str,
        runtime: &Arc<Runtime>,
        require_resume: bool,
    ) -> Result<(), String> {
        let harness = self.view(id)?.binding.harness_id;
        let policy = self.host_tools_policy(&harness);
        let is_antigravity = harness == "acp:antigravity";
        let client_info = if is_antigravity {
            let ver = tokio::task::spawn_blocking(detect_agy_cli_version)
                .await
                .ok()
                .flatten();
            antigravity_client_info(ver)
        } else {
            json!({ "name": "Codev", "version": env!("CARGO_PKG_VERSION") })
        };
        let initialize = runtime
            .bridge
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": client_info,
                    "clientCapabilities": {
                        "fs": {
                            "readTextFile": !is_antigravity && policy.read != "deny",
                            "writeTextFile": !is_antigravity && policy.write != "deny"
                        },
                        "terminal": false
                    }
                }),
                TIMEOUT,
            )
            .await
            .map_err(|error| with_auth_hint(&harness, format_acp_error(&error, &runtime.bridge.diagnostic_tail())))?;
        if initialize.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err("代理返回了不兼容的协议版本".into());
        }
        if is_antigravity {
            let supports_steer = initialize
                .pointer("/agentInfo/version")
                .and_then(Value::as_str)
                .and_then(parse_semver3)
                .is_some_and(|v| v >= (1, 5, 0));
            runtime
                .supports_prompt_steer
                .store(supports_steer, std::sync::atomic::Ordering::Release);
        }
        if harness == "acp:codex" {
            if let Some(provider) = super::providers::selected(self, &harness)? {
                super::providers::apply_codex(runtime, Some(&provider)).await?;
            }
        }
        let capabilities = initialize
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        let supports_load = capabilities
            .get("loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supports_resume_cap = capabilities
            .pointer("/sessionCapabilities/resume")
            .is_some_and(|v| !v.is_null());
        let resume = supports_load || supports_resume_cap;
        let view = self.view(id)?;
        let desktop = antigravity_history::is_desktop(&view.binding);
        let imported_codex = harness == "acp:codex" && view.binding.imported;
        let mut cwd = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作目录不存在")?;
        if desktop {
            cwd = super::metadata::display_path(&antigravity_history::desktop_cwd(
                view.binding.native_session_id.as_deref().ok_or("缺少 Antigravity 会话标识")?,
            )?);
        }
        self.update(id, Some(&runtime.instance), |v| {
            v.capabilities = Capabilities {
                supports_resume: resume,
                supports_thinking: harness == "acp:codex",
                supports_images: capabilities
                    .pointer("/promptCapabilities/image")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                supports_file_mentions: true,
                supports_queue: true,
                ..Capabilities::default()
            }
        });
        let native = lock(&runtime.native_id).clone();
        let was_fresh = native.is_none();
        let was_empty = view.messages.is_empty();
        let mut recovered = false;
        let response = if let Some(native) = native {
            if !resume {
                return Err("该代理不支持恢复原生会话；请新建会话，原有绑定已保留".into());
            }
            if is_antigravity && supports_resume_cap {
                let res = runtime
                    .bridge
                    .request(
                        "session/resume",
                        json!({"sessionId":native,"cwd":cwd,"mcpServers":[]}),
                        TIMEOUT,
                    )
                    .await;
                let res = match res {
                    Ok(v) => Ok(v),
                    Err(err) if err.to_ascii_lowercase().contains("auth") || err.to_ascii_lowercase().contains("login") => {
                        let auth_method = initialize
                            .get("authMethods")
                            .and_then(Value::as_array)
                            .and_then(|arr| arr.iter().find(|m| text(m, "id") == "oauth-personal" || text(m, "type") == "agent"))
                            .map(|m| text(m, "id"));
                        if let Some(method_id) = auth_method.filter(|s| !s.is_empty()) {
                            let _ = runtime.bridge.request("authenticate", json!({"methodId": method_id}), TIMEOUT).await;
                            runtime
                                .bridge
                                .request("session/resume", json!({"sessionId":native,"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                                .await
                        } else {
                            Err(err)
                        }
                    }
                    other => other,
                };
                match res {
                    Ok(v) => v,
                    Err(error) => {
                        if imported_codex || require_resume {
                            self.update(id, Some(&runtime.instance), |v| {
                                v.messages = view.messages.clone();
                                v.history_available = view.history_available;
                                v.history_offset = view.history_offset;
                            });
                        }
                        return Err(with_auth_hint(&harness, format_acp_error(&error, &runtime.bridge.diagnostic_tail())));
                    }
                }
            } else {
                if !desktop {
                    self.update(id, Some(&runtime.instance), |v| {
                        v.messages.clear();
                        v.history_available = false;
                    });
                }
                if desktop {
                    runtime.loading_desktop_history.store(true, std::sync::atomic::Ordering::Release);
                } else {
                    runtime.loading_history.store(true, std::sync::atomic::Ordering::Release);
                }
                runtime.touch_activity();
                let mut load_fut = Box::pin(runtime.bridge.request(
                    "session/load",
                    json!({"sessionId":native,"cwd":cwd,"mcpServers":[]}),
                    TIMEOUT,
                ));
                let load_start_ms = now_ms();
                let mut replay_provisional = false;
                let mut poll = tokio::time::interval(Duration::from_millis(200));
                poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let loaded = loop {
                    tokio::select! {
                        res = &mut load_fut => break res,
                        _ = poll.tick() => {
                            let last = runtime.last_activity_ms.load(std::sync::atomic::Ordering::Acquire);
                            if last > load_start_ms
                                && now_ms().saturating_sub(last) >= REPLAY_IDLE_GAP.as_millis() as u64
                            {
                                replay_provisional = true;
                                break Ok(json!({ "sessionId": native }));
                            }
                        }
                    }
                };
                let drained = runtime.bridge.drain_events().await;
                if desktop {
                    runtime.loading_desktop_history.store(false, std::sync::atomic::Ordering::Release);
                    if !replay_provisional {
                        drained?;
                    }
                } else {
                    runtime.loading_history.store(false, std::sync::atomic::Ordering::Release);
                    if loaded.is_ok() && !replay_provisional {
                        drained?;
                    }
                }
                match loaded {
                    Ok(value) => value,
                    Err(error) if !require_resume && !desktop && !imported_codex && !is_antigravity && recoverable_missing_session(&error) => {
                        recovered = true;
                        *lock(&runtime.native_id) = None;
                        self.update(id, Some(&runtime.instance), |v| {
                            v.messages.clear();
                        });
                        runtime
                            .bridge
                            .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                            .await
                            .map_err(|error| with_auth_hint(&harness, format_acp_error(&error, &runtime.bridge.diagnostic_tail())))?
                    }
                    Err(error) => {
                        if imported_codex || require_resume {
                            self.update(id, Some(&runtime.instance), |v| {
                                v.messages = view.messages.clone();
                                v.history_available = view.history_available;
                                v.history_offset = view.history_offset;
                            });
                        }
                        return Err(with_auth_hint(&harness, format_acp_error(&error, &runtime.bridge.diagnostic_tail())));
                    }
                }
            }
        } else {
            let res = runtime
                .bridge
                .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                .await;
            match res {
                Ok(v) => v,
                Err(err) if is_antigravity && (err.to_ascii_lowercase().contains("auth") || err.to_ascii_lowercase().contains("login")) => {
                    let auth_method = initialize
                        .get("authMethods")
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.iter().find(|m| text(m, "id") == "oauth-personal" || text(m, "type") == "agent"))
                        .map(|m| text(m, "id"));
                    if let Some(method_id) = auth_method.filter(|s| !s.is_empty()) {
                        let _ = runtime.bridge.request("authenticate", json!({"methodId": method_id}), TIMEOUT).await;
                        runtime
                            .bridge
                            .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), TIMEOUT)
                            .await
                            .map_err(|error| with_auth_hint(&harness, format_acp_error(&error, &runtime.bridge.diagnostic_tail())))?
                    } else {
                        return Err(with_auth_hint(&harness, format_acp_error(&err, &runtime.bridge.diagnostic_tail())));
                    }
                }
                Err(err) => {
                    return Err(with_auth_hint(&harness, format_acp_error(&err, &runtime.bridge.diagnostic_tail())));
                }
            }
        };
        let native = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| lock(&runtime.native_id).clone())
            .ok_or("代理没有返回会话标识")?;
        if desktop && view.binding.native_session_id.as_deref() != Some(native.as_str()) {
            return Err("Antigravity 返回的会话标识与桌面历史不一致".into());
        }
        if (imported_codex || require_resume) && view.binding.native_session_id.is_some()
            && view.binding.native_session_id.as_deref() != Some(native.as_str()) {
            self.update(id, Some(&runtime.instance), |v| {
                v.messages = view.messages.clone();
                v.history_available = view.history_available;
                v.history_offset = view.history_offset;
            });
            return Err("代理返回的会话标识与原生历史不一致".into());
        }
        *lock(&runtime.native_id) = Some(native.clone());
        let native_for_model = native.clone();
        let (provider_label, allowed_models) = super::providers::acp_provider_scope(
            self,
            id,
            &harness,
            !was_fresh,
            desktop,
        );
        let available_models = response
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .cloned();
        self.update(id, Some(&runtime.instance), |v| {
            v.binding.native_session_id = Some(native);
            apply_session(v, &response);
            apply_provider_scope_to_view(
                v,
                &provider_label,
                allowed_models.as_deref(),
                available_models.as_deref(),
            );
            for m in &mut v.messages {
                m.streaming = false;
                if m.status == "streaming" {
                    m.status = "completed".into();
                }
            }
            v.history_loaded = true;
            if recovered {
                v.history_available = false;
                v.messages.push(Message {
                    id: new_id(),
                    kind: "notice".into(),
                    role: "system".into(),
                    text: "原代理会话已无法恢复，Codev 已建立新的原生会话；旧会话的原生记录未被修改。".into(),
                    status: "completed".into(),
                    created_at: now_ms(),
                    ..Message::default()
                });
            }
        });
        self.persist(id)?;
        let active_provider = super::providers::acp_session_provider(
            self,
            id,
            &harness,
            !was_fresh,
            desktop,
        )?;
        let should_apply_default_model = match harness.as_str() {
            "acp:codex" => true,
            "acp:antigravity" => active_provider.is_some() || (!desktop && (was_fresh || recovered || was_empty)),
            _ => false,
        };
        let prefs = self.view(id)?.binding.preferences;
        let harness_prefs = self.harness_preferences(&harness);
        let scoped_available: Option<Vec<Value>> = available_models.as_ref().map(|avail| {
            if let Some(ref allowed) = allowed_models {
                if !allowed.is_empty() {
                    let view_ids: std::collections::HashSet<String> = self
                        .view(id)
                        .map(|v| v.models.iter().map(|m| text(m, "id")).collect())
                        .unwrap_or_default();
                    return avail
                        .iter()
                        .filter(|m| {
                            let mid = text(m, "modelId");
                            let (base, _) = split_tiered_model(&mid, &[]);
                            view_ids.contains(&mid)
                                || base.is_some_and(|b| view_ids.contains(&b))
                                || allowed.iter().any(|a| a.eq_ignore_ascii_case(&mid))
                        })
                        .cloned()
                        .collect();
                }
            }
            avail.clone()
        });
        let saved_model = prefs.model_id.as_deref().filter(|s| !s.is_empty());
        let provider_default = if should_apply_default_model {
            active_provider
                .as_ref()
                .map(|p| p.model.trim())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        let fresh_harness_model = if was_fresh && provider_default.is_none() {
            harness_prefs.model_id.as_deref().filter(|s| !s.is_empty())
        } else {
            None
        };
        let mut applied_explicit_model = false;
        if let Some(candidate) = saved_model.or(fresh_harness_model) {
            let view = self.view(id)?;
            if let Some(target) =
                resolve_acp_model(candidate, &view.models, scoped_available.as_deref())
            {
                let already = match &target {
                    AcpModelResolution::ConfigValue(mid) => {
                        view.model.as_ref().map(|m| text(m, "id")) == Some(mid.clone())
                    }
                    AcpModelResolution::AvailableModel {
                        model_id,
                        base_value,
                        ..
                    } => {
                        let cur = view.model.as_ref().map(|m| text(m, "id"));
                        cur == Some(model_id.clone())
                            || (base_value.is_some() && cur == *base_value)
                    }
                };
                if already
                    || self
                        .apply_acp_model_target(id, runtime, &native_for_model, target)
                        .await
                        .is_ok()
                {
                    applied_explicit_model = true;
                }
            }
        }
        if !applied_explicit_model {
            if let Some(default_model) = provider_default {
                let view = self.view(id)?;
                let target = resolve_acp_model(
                    default_model,
                    &view.models,
                    available_models.as_deref(),
                )
                .ok_or_else(|| {
                    if harness == "acp:antigravity" {
                        format!(
                            "当前 Antigravity 供应商配置的默认模型“{}”不被 agy CLI 支持，请检查或改用受支持的 Gemini 模型（如 gemini-4-hydrogen）",
                            default_model
                        )
                    } else {
                        format!(
                            "供应商未返回模型 {}，请检查模型名称或供应商模型列表",
                            default_model
                        )
                    }
                })?;
                self.apply_acp_model_target(id, runtime, &native_for_model, target)
                    .await?;
            }
        }
        let view_after_model = self.view(id)?;
        let desired_thinking = prefs
            .thinking_level
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                was_fresh
                    .then_some(harness_prefs.thinking_level.as_deref())
                    .flatten()
                    .filter(|s| !s.is_empty())
            });
        if let Some(tier) = desired_thinking {
            let thought_config_id = view_after_model
                .config_options
                .iter()
                .find(|c| {
                    matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                        || text(c, "id").contains("thinking")
                        || text(c, "id") == "thought_level"
                })
                .map(|c| text(c, "id"))
                .unwrap_or_default();
            if !thought_config_id.is_empty()
                && view_after_model.thinking_levels.iter().any(|t| t == tier)
                && view_after_model.thinking_level != tier
            {
                let _ = self
                    .set_acp_config(id, runtime, &thought_config_id, tier)
                    .await;
            } else if thought_config_id.is_empty()
                && harness == "acp:codex"
                && view_after_model.thinking_levels.iter().any(|t| t == tier)
                && view_after_model.thinking_level != tier
            {
                let _ = self
                    .apply_codex_thinking_fallback(id, runtime, tier)
                    .await;
            }
        }
        let mut desired_configs = if was_fresh {
            harness_prefs.configs
        } else {
            std::collections::BTreeMap::new()
        };
        for (cid, val) in prefs.configs {
            desired_configs.insert(cid, val);
        }
        if !desired_configs.is_empty() {
            let current_view = self.view(id)?;
            for (cid, val) in desired_configs {
                let Some(opt) = current_view
                    .config_options
                    .iter()
                    .find(|c| text(c, "id") == cid)
                else {
                    continue;
                };
                if text(opt, "currentValue") == val {
                    continue;
                }
                let allowed = if text(opt, "type") == "boolean" {
                    val == "true" || val == "false"
                } else {
                    options(opt.get("options").unwrap_or(&Value::Null))
                        .iter()
                        .any(|c| text(c, "value") == val)
                };
                if allowed {
                    let _ = self.set_acp_config(id, runtime, &cid, &val).await;
                }
            }
        }
        Ok(())
    }

    async fn apply_acp_model_target(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        native_for_model: &str,
        target: AcpModelResolution,
    ) -> Result<(), String> {
        let view = self.view(id)?;
        let config_id = view
            .config_options
            .iter()
            .find(|c| text(c, "category") == "model" || text(c, "id") == "model")
            .map(|c| text(c, "id"))
            .unwrap_or_default();
        let thought_config_id = view
            .config_options
            .iter()
            .find(|c| {
                matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                    || text(c, "id").contains("thinking")
                    || text(c, "id") == "thought_level"
            })
            .map(|c| text(c, "id"))
            .unwrap_or_default();
        match target {
            AcpModelResolution::ConfigValue(model_id) => {
                if config_id.is_empty() {
                    runtime
                        .bridge
                        .request(
                            "session/set_model",
                            json!({"sessionId":native_for_model,"modelId":model_id}),
                            TIMEOUT,
                        )
                        .await?;
                    self.update(id, Some(&runtime.instance), |v| {
                        v.model = v
                            .models
                            .iter()
                            .find(|m| text(m, "id") == model_id)
                            .cloned();
                    });
                } else {
                    self.set_acp_config(id, runtime, &config_id, &model_id).await?;
                }
            }
            AcpModelResolution::AvailableModel {
                model_id,
                base_value,
                thought_level,
            } => {
                if !config_id.is_empty() {
                    if let Some(base) = base_value {
                        self.set_acp_config(id, runtime, &config_id, &base).await?;
                        if let Some(tier) = thought_level {
                            if !thought_config_id.is_empty()
                                && self.view(id)?.thinking_levels.iter().any(|t| t == &tier)
                            {
                                let _ = self
                                    .set_acp_config(id, runtime, &thought_config_id, &tier)
                                    .await;
                            }
                        }
                    } else {
                        runtime
                            .bridge
                            .request(
                                "session/set_model",
                                json!({"sessionId":native_for_model,"modelId":model_id}),
                                TIMEOUT,
                            )
                            .await?;
                    }
                } else {
                    runtime
                        .bridge
                        .request(
                            "session/set_model",
                            json!({"sessionId":native_for_model,"modelId":model_id}),
                            TIMEOUT,
                        )
                        .await?;
                    self.update(id, Some(&runtime.instance), |v| {
                        v.model = v
                            .models
                            .iter()
                            .find(|m| text(m, "id") == model_id)
                            .cloned();
                    });
                }
            }
        }
        Ok(())
    }
    pub fn handle_acp_frame(self: &Arc<Self>, id: &str, runtime: &Arc<Runtime>, frame: Value) {
        runtime.touch_activity();
        let method = text(&frame, "method");
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        if method == "session/update" {
            let update_peek = params.get("update").unwrap_or(&Value::Null);
            let kind_peek = text(update_peek, "sessionUpdate");
            if kind_peek == "tool_call_update" {
                let status = update_peek.get("status").and_then(Value::as_str);
                let is_pending = matches!(status, None | Some("in_progress" | "pending"));
                if is_pending
                    && update_peek.get("title").is_none()
                    && update_peek.get("locations").is_none()
                    && update_peek.get("rawInput").is_none()
                    && update_peek.get("rawOutput").is_none()
                {
                    let empty_content = update_peek
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|c| {
                            !c.iter().any(|entry| entry.get("diff").is_some())
                                && c.iter()
                                    .map(|entry| history::content_text(entry.get("content").unwrap_or(entry)).len())
                                    .sum::<usize>()
                                    == 0
                        })
                        .unwrap_or(true);
                    let call_id = text(update_peek, "toolCallId");
                    let already_exists = self.view(id).is_ok_and(|v| {
                        v.messages
                            .iter()
                            .any(|m| m.tool_call_id == call_id && (m.kind == "toolCall" || m.kind == "plan"))
                    });
                    if empty_content && already_exists {
                        return;
                    }
                }
            }
        }
        match method.as_str() {
            "session/update" => {
                let update = params.get("update").unwrap_or(&Value::Null);
                let kind = text(update, "sessionUpdate");
                if runtime.loading_desktop_history.load(std::sync::atomic::Ordering::Acquire)
                    && matches!(kind.as_str(), "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" | "tool_call" | "tool_call_update" | "plan")
                {
                    return;
                }
                let event_ts = {
                    let explicit = history::parse_timestamp_ms(
                        update.get("timestamp").or_else(|| params.get("timestamp")),
                    );
                    if explicit > 0 {
                        explicit
                    } else if runtime.loading_history.load(std::sync::atomic::Ordering::Acquire) {
                        0
                    } else {
                        now_ms()
                    }
                };
                let pending_overlay = lock(&runtime.pending_config).clone();
                let config_scope = if kind == "config_option_update" {
                    self.view(id).ok().map(|v| {
                        super::providers::acp_provider_scope(
                            self,
                            id,
                            &v.binding.harness_id,
                            v.binding.native_session_id.is_some(),
                            antigravity_history::is_desktop(&v.binding),
                        )
                    })
                } else {
                    None
                };
                self.update(id, Some(&runtime.instance), |v| match kind.as_str() {
                    "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
                        let role = if kind == "user_message_chunk" {
                            "user"
                        } else {
                            "assistant"
                        };
                        let thought = kind == "agent_thought_chunk";
                        let content = update.get("content").unwrap_or(&Value::Null);
                        let chunk = history::content_text(content);
                        let same = v
                            .messages
                            .last()
                            .filter(|m| m.kind == "message" && m.role == role && m.streaming)
                            .map(|m| m.id.clone());
                        if same.is_none() {
                            v.messages.push(Message {
                                id: new_id(),
                                kind: "message".into(),
                                role: role.into(),
                                streaming: true,
                                status: "streaming".into(),
                                created_at: event_ts,
                                raw_kind: kind.clone(),
                                ..Message::default()
                            });
                        }
                        if let Some(message) = v.messages.last_mut() {
                            if thought {
                                message.thinking.push_str(&chunk);
                            } else {
                                message.text.push_str(&chunk);
                            }
                            if text(content, "type") == "image" {
                                message.images.push(content.clone());
                            }
                        }
                    }
                    "tool_call" | "tool_call_update" => {
                        for message in &mut v.messages {
                            message.streaming = false;
                        }
                        let call = text(update, "toolCallId");
                        let raw_title = update.get("title").and_then(Value::as_str);
                        let raw_kind = update.get("kind").and_then(Value::as_str);
                        let is_update_steps = {
                            let mut calls = lock(&runtime.update_steps_calls);
                            if raw_title == Some("Run update_steps")
                                && matches!(raw_kind, None | Some("") | Some("other"))
                            {
                                calls.insert(call.clone());
                            }
                            let tracked = calls.contains(&call);
                            if tracked
                                && matches!(
                                    update.get("status").and_then(Value::as_str),
                                    Some("completed" | "failed" | "error")
                                )
                            {
                                calls.remove(&call);
                            }
                            tracked
                        };
                        if is_update_steps {
                            if let Some(entries) = update
                                .get("rawInput")
                                .and_then(extract_antigravity_update_steps)
                            {
                                let plan_id = format!("acp-plan:{}:{call}", runtime.instance);
                                let serialized =
                                    serde_json::to_string_pretty(&entries).unwrap_or_default();
                                if let Some(plan_msg) =
                                    v.messages.iter_mut().rfind(|m| m.id == plan_id)
                                {
                                    plan_msg.text = serialized;
                                } else {
                                    v.messages.push(Message {
                                        id: plan_id,
                                        kind: "plan".into(),
                                        role: "system".into(),
                                        text: serialized,
                                        created_at: event_ts,
                                        raw_kind: kind.clone(),
                                        ..Message::default()
                                    });
                                }
                            }
                            return;
                        }
                        let existing = v
                            .messages
                            .iter()
                            .rposition(|m| m.tool_call_id == call && m.kind == "toolCall");
                        let index = if let Some(i) = existing {
                            i
                        } else {
                            v.messages.push(Message {
                                id: format!("acp-tool:{}:{call}", runtime.instance),
                                kind: "toolCall".into(),
                                role: "tool".into(),
                                tool_call_id: call,
                                created_at: event_ts,
                                raw_kind: kind.clone(),
                                ..Message::default()
                            });
                            v.messages.len() - 1
                        };
                        let tool = &mut v.messages[index];
                        if let Some(title) = update.get("title").and_then(Value::as_str) {
                            tool.tool_name = bound_tail(title, TOOL_TEXT_LIMIT);
                        }
                        if let Some(tk) = update.get("kind").and_then(Value::as_str) {
                            tool.tool_kind = tk.into();
                        }
                        if let Some(locs) = update.get("locations").and_then(Value::as_array) {
                            if !locs.is_empty() {
                                tool.locations = locs.clone();
                            }
                        }
                        if let Some(status) = update.get("status").and_then(Value::as_str) {
                            tool.status = status.into();
                            tool.is_error = matches!(status, "failed" | "error");
                        }
                        if let Some(args) = update.get("rawInput") {
                            let is_empty_obj = args
                                .as_object()
                                .is_some_and(serde_json::Map::is_empty);
                            let has_existing = tool
                                .arguments
                                .as_object()
                                .is_some_and(|o| !o.is_empty());
                            if !args.is_null() && !(is_empty_obj && has_existing) {
                                tool.arguments = sanitize_acp_tool_payload(args);
                                tool.clamp_arguments_size();
                            }
                        }
                        if let Some(output) = update.get("rawOutput") {
                            let sanitized_output = sanitize_acp_tool_payload(output);
                            let next_text = if sanitized_output.is_string() {
                                sanitized_output.as_str().unwrap_or_default().into()
                            } else {
                                serde_json::to_string_pretty(&sanitized_output).unwrap_or_default()
                            };
                            tool.text = next_text;
                        }
                        if let Some(content) = update.get("content").and_then(Value::as_array) {
                            let mut diffs = vec![];
                            let mut blocks = vec![];
                            for c in content {
                                let cleaned = sanitize_acp_tool_payload(c);
                                if let Some(diff) = cleaned.get("diff") {
                                    diffs.push(diff.clone());
                                    let old_t = text(diff, "oldText");
                                    let new_t = text(diff, "newText");
                                    if !old_t.is_empty() || !new_t.is_empty() {
                                        blocks.push(format!("--- old\n{old_t}\n+++ new\n{new_t}"));
                                    }
                                } else {
                                    let txt = history::content_text(
                                        cleaned.get("content").unwrap_or(&cleaned),
                                    );
                                    if !txt.is_empty() {
                                        blocks.push(bound_tail(&txt, TOOL_TEXT_LIMIT));
                                    }
                                }
                            }
                            if let Some(first) = diffs.first() {
                                tool.diff = if diffs.len() == 1 {
                                    Some(first.clone())
                                } else {
                                    Some(json!({ "items": diffs }))
                                };
                            }
                            if !blocks.is_empty() {
                                tool.text = bound_tail(&blocks.join("\n"), TOOL_TEXT_LIMIT * 2);
                            }
                        }
                    }
                    "config_option_update" => {
                        if let Some(config) = update.get("configOptions").and_then(Value::as_array)
                        {
                            apply_config(v, config.clone());
                            if let Some((ref label, ref allowed)) = config_scope {
                                apply_provider_scope_to_view(v, label, allowed.as_deref(), None);
                            }
                            pending_overlay.overlay_on_view(v);
                        }
                    }
                    "current_mode_update" => {
                        if let Some(mode) = v
                            .config_options
                            .iter_mut()
                            .find(|c| text(c, "id") == "$mode")
                        {
                            mode["currentValue"] =
                                update.get("currentModeId").cloned().unwrap_or(Value::Null);
                        }
                        pending_overlay.overlay_on_view(v);
                    }
                    "session_info_update" => {
                        if let Some(title) = update.get("title").and_then(Value::as_str) {
                            v.binding.title = title.chars().take(160).collect();
                        }
                    }
                    "available_commands_update" => {
                        v.commands = update
                            .get("availableCommands")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        v.capabilities.supports_skills = !v.commands.is_empty();
                    }
                    "plan" => {
                        v.messages.push(Message {
                            id: new_id(),
                            kind: "plan".into(),
                            role: "system".into(),
                            text: serde_json::to_string_pretty(
                                update.get("entries").unwrap_or(&Value::Null),
                            )
                            .unwrap_or_default(),
                            raw_kind: kind.clone(),
                            ..Message::default()
                        });
                    }
                    "usage_update" => {
                        v.context = merge_acp_usage_update(&v.context, update);
                        v.capabilities.supports_context_usage = true;
                    }
                    _ => {}
                });
            }
            "session/request_permission" => {
                let Some(native_id) = frame.get("id").cloned() else {
                    return;
                };
                let policy = self
                    .view(id)
                    .ok()
                    .map(|v| self.host_tools_policy(&v.binding.harness_id))
                    .unwrap_or_default();
                if !is_antigravity_interaction_permission(&params) {
                    if let Some(outcome) = resolve_permission_auto_reply(&policy, &params) {
                        if let Err(err) = runtime
                            .bridge
                            .send(json!({"jsonrpc":"2.0","id":native_id,"result":{"outcome": outcome}}))
                        {
                            runtime.bridge.diagnostic(format!("自动审批回复失败：{err}"));
                        }
                        self.update(id, Some(&runtime.instance), |v| {
                            v.capabilities.supports_permission = true;
                        });
                        return;
                    }
                }
                let key = new_id();
                lock(&runtime.permission_ids).insert(key.clone(), native_id);
                let tool = params.get("toolCall").unwrap_or(&Value::Null);
                let is_interaction = is_antigravity_interaction_permission(&params);
                let sanitized_input = tool
                    .get("rawInput")
                    .map(sanitize_acp_tool_payload)
                    .filter(|v| !v.is_null() && !v.as_object().is_some_and(serde_json::Map::is_empty));
                self.update(id, Some(&runtime.instance), |v| {
                    v.capabilities.supports_permission = true;
                    v.pending_requests.push(PendingRequest {
                        id: key,
                        kind: "permission".into(),
                        title: text(tool, "title"),
                        message: if is_interaction {
                            String::new()
                        } else {
                            sanitized_input
                                .as_ref()
                                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                                .unwrap_or_default()
                        },
                        options: params
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                        default_value: String::new(),
                    });
                });
            }
            "fs/read_text_file" | "fs/write_text_file" => {
                let Some(request_id) = frame.get("id").cloned() else {
                    return;
                };
                let host = self.clone();
                let sid = id.to_string();
                let run = runtime.clone();
                tokio::spawn(async move {
                    let reply = host
                        .agent_file(&sid, &params, method == "fs/write_text_file")
                        .await;
                    let result = match reply {
                        Ok(value) => json!({"jsonrpc":"2.0","id":request_id,"result":value}),
                        Err(e) => {
                            json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32000,"message":e}})
                        }
                    };
                    let _ = run.bridge.send(result);
                });
            }
            _ => {
                if let Some(request_id) = frame.get("id") {
                    let _=runtime.bridge.send(json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Codev 未声明支持此客户端方法"}}));
                }
            }
        }
    }
    pub async fn set_acp_config(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        config_id: &str,
        value: &str,
    ) -> Result<Value, String> {
        let native = lock(&runtime.native_id).clone().ok_or("会话尚未初始化")?;
        let response = if config_id == "$mode" {
            runtime
                .bridge
                .request(
                    "session/set_mode",
                    json!({"sessionId":native,"modeId":value}),
                    TIMEOUT,
                )
                .await?
        } else {
            runtime
                .bridge
                .request(
                    "session/set_config_option",
                    json!({"sessionId":native,"configId":config_id,"value":value}),
                    TIMEOUT,
                )
                .await?
        };
        let (provider_label, allowed_models) = self.view(id).ok().map_or_else(
            || (String::new(), None),
            |v| {
                super::providers::acp_provider_scope(
                    self,
                    id,
                    &v.binding.harness_id,
                    v.binding.native_session_id.is_some(),
                    antigravity_history::is_desktop(&v.binding),
                )
            },
        );
        self.update(id, Some(&runtime.instance), |v| {
            if let Some(config) = response.get("configOptions").and_then(Value::as_array) {
                apply_config(v, config.clone());
            } else if let Some(option) = v
                .config_options
                .iter_mut()
                .find(|c| text(c, "id") == config_id)
            {
                option["currentValue"] = json!(value);
                let config = v.config_options.clone();
                apply_config(v, config);
            }
            if !provider_label.is_empty() {
                apply_provider_scope_to_view(
                    v,
                    &provider_label,
                    allowed_models.as_deref(),
                    None,
                );
            }
        });
        Ok(response)
    }

    pub(super) async fn apply_codex_thinking_fallback(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        level: &str,
    ) -> Result<Value, String> {
        let view = self.view(id)?;
        let thought_config_id = view
            .config_options
            .iter()
            .find(|c| {
                matches!(text(c, "category").as_str(), "thought_level" | "thinking")
                    || text(c, "id").contains("thinking")
                    || text(c, "id") == "thought_level"
            })
            .map(|c| text(c, "id"))
            .unwrap_or_default();
        if !thought_config_id.is_empty() {
            return self
                .set_acp_config(id, runtime, &thought_config_id, level)
                .await;
        }
        let native = lock(&runtime.native_id).clone().ok_or("会话尚未初始化")?;
        if let Some(model_id) = view
            .model
            .as_ref()
            .map(|m| text(m, "id"))
            .filter(|s| !s.is_empty())
        {
            let base = model_id.split('/').next().unwrap_or(&model_id);
            let tiered = format!("{base}/{level}");
            if let Ok(res) = runtime
                .bridge
                .request(
                    "session/set_model",
                    json!({ "sessionId": native, "modelId": tiered }),
                    TIMEOUT,
                )
                .await
            {
                self.update(id, Some(&runtime.instance), |v| {
                    v.thinking_level = level.to_string();
                });
                return Ok(res);
            }
        }
        self.update(id, Some(&runtime.instance), |v| {
            v.thinking_level = level.to_string();
        });
        Ok(json!({ "ok": true }))
    }
    pub(super) async fn agent_file(
        &self,
        id: &str,
        params: &Value,
        write: bool,
    ) -> Result<Value, String> {
        let view = self.view(id)?;
        let policy = self.host_tools_policy(&view.binding.harness_id);
        if write && policy.write == "deny" {
            return Err("当前策略禁止代理写入工作区文件".into());
        }
        if !write && policy.read == "deny" {
            return Err("当前策略禁止代理读取工作区文件".into());
        }
        let root = lock(&self.state)
            .workspaces
            .get(&view.binding.workspace_id)
            .map(|w| w.cwd.clone())
            .ok_or("工作区不存在")?;
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let requested = std::path::PathBuf::from(text(params, "path"));
        let requested = if requested.is_absolute() {
            requested
        } else {
            root.join(requested)
        };
        let canonical = if requested.exists() {
            std::fs::canonicalize(&requested)
        } else {
            requested
                .parent()
                .ok_or("文件路径无效")
                .and_then(|p| std::fs::canonicalize(p).map_err(|_| "父目录不存在"))
                .map(|p| p.join(requested.file_name().unwrap_or_default()))
                .map_err(std::io::Error::other)
        }
        .map_err(|e| e.to_string())?;
        let outside_allowed = policy.allow_outside_workspace
            || policy.permission == "allow_all"
            || (!write && policy.permission == "allow_read");
        if !outside_allowed && !canonical.starts_with(&root) {
            return Err("代理文件请求超出绑定工作区".into());
        }
        if write {
            let content = text(params, "content");
            if content.len() > 8 * 1024 * 1024 {
                return Err("文件内容超过限制".into());
            }
            let runtime = lock(&self.runtimes).get(id).cloned();
            let auto_allow = policy.write == "allow"
                || runtime
                    .as_ref()
                    .is_some_and(|r| r.session_auto_write.load(std::sync::atomic::Ordering::Acquire));
            if !auto_allow {
                let Some(runtime) = runtime else {
                    return Err("写入需要运行时确认".into());
                };
                let rel = canonical
                    .strip_prefix(&root)
                    .map(super::metadata::display_path)
                    .unwrap_or_else(|_| super::metadata::display_path(&canonical));
                let existing = tokio::fs::read_to_string(&canonical).await.unwrap_or_default();
                let preview = if existing.is_empty() {
                    format!(
                        "新建文件 {rel}（{} 字节）\n{}",
                        content.len(),
                        content.lines().take(20).collect::<Vec<_>>().join("\n")
                    )
                } else {
                    format!(
                        "覆盖写入 {rel}（原 {} 字节 -> 新 {} 字节）\n{}",
                        existing.len(),
                        content.len(),
                        content.lines().take(20).collect::<Vec<_>>().join("\n")
                    )
                };
                let request_id = format!("fs-write:{}", new_id());
                let (tx, rx) = tokio::sync::oneshot::channel();
                lock(&runtime.fs_approvals).insert(request_id.clone(), tx);
                self.update(id, Some(&runtime.instance), |v| {
                    v.capabilities.supports_permission = true;
                    v.pending_requests.push(PendingRequest {
                        id: request_id.clone(),
                        kind: "permission".into(),
                        title: format!("写入工作区文件：{rel}"),
                        message: preview,
                        options: vec![
                            json!({"optionId":"allow_once","name":"允许本次写入","kind":"allow_once"}),
                            json!({"optionId":"allow_session","name":"本会话允许自动写入","kind":"allow_always"}),
                            json!({"optionId":"reject","name":"拒绝写入","kind":"reject_once"}),
                        ],
                        default_value: "reject".into(),
                    });
                });
                let approved = rx.await.unwrap_or(false);
                self.update(id, Some(&runtime.instance), |v| {
                    v.pending_requests.retain(|p| p.id != request_id);
                });
                if !approved {
                    return Err("用户拒绝写入文件".into());
                }
            }
            tokio::fs::write(canonical, content)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        } else {
            let meta = tokio::fs::metadata(&canonical)
                .await
                .map_err(|e| e.to_string())?;
            if meta.len() > 8 * 1024 * 1024 {
                return Err("文件超过读取限制".into());
            }
            let content = tokio::fs::read_to_string(canonical)
                .await
                .map_err(|e| e.to_string())?;
            let start = params
                .get("line")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .saturating_sub(1) as usize;
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX)
                .min(usize::MAX as u64) as usize;
            Ok(
                json!({"content":content.lines().skip(start).take(limit).collect::<Vec<_>>().join("\n")}),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_agy_options() -> (Vec<Value>, Vec<Value>) {
        let view_models = vec![
            json!({"id": "gemini-4-neon", "name": "Gemini 4 Neon", "provider": "acp:antigravity", "configId": "model"}),
            json!({"id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen", "provider": "acp:antigravity", "configId": "model"}),
            json!({"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro", "provider": "acp:antigravity", "configId": "model"}),
        ];
        let available = vec![
            json!({"modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)"}),
            json!({"modelId": "gemini-4-hydrogen-xhigh", "name": "Gemini 4 Hydrogen (XHigh)"}),
            json!({"modelId": "gemini-4-hydrogen-low", "name": "Gemini 4 Hydrogen (Low)"}),
        ];
        (view_models, available)
    }

    #[test]
    fn resolves_base_display_and_tiered_antigravity_models() {
        let (view_models, available) = sample_agy_options();
        assert_eq!(
            resolve_acp_model("gemini-4-hydrogen", &view_models, Some(&available)),
            Some(AcpModelResolution::ConfigValue("gemini-4-hydrogen".into()))
        );
        assert_eq!(
            resolve_acp_model("models/gemini-4-hydrogen", &view_models, Some(&available)),
            Some(AcpModelResolution::ConfigValue("gemini-4-hydrogen".into()))
        );
        assert_eq!(
            resolve_acp_model("Gemini 4 Hydrogen", &view_models, Some(&available)),
            Some(AcpModelResolution::ConfigValue("gemini-4-hydrogen".into()))
        );
        assert_eq!(
            resolve_acp_model("Gemini 4 Hydrogen (XHigh)", &view_models, Some(&available)),
            Some(AcpModelResolution::AvailableModel {
                model_id: "gemini-4-hydrogen-xhigh".into(),
                base_value: Some("gemini-4-hydrogen".into()),
                thought_level: Some("xhigh".into()),
            })
        );
        assert_eq!(
            resolve_acp_model("gemini-4-hydrogen-low", &view_models, Some(&available)),
            Some(AcpModelResolution::AvailableModel {
                model_id: "gemini-4-hydrogen-low".into(),
                base_value: Some("gemini-4-hydrogen".into()),
                thought_level: Some("low".into()),
            })
        );
    }

    #[test]
    fn scopes_and_labels_antigravity_models_to_bound_provider() {
        let (view_models, available) = sample_agy_options();
        let mut view = SessionView::new(SessionBinding {
            id: "s1".into(),
            workspace_id: "w1".into(),
            harness_id: "acp:antigravity".into(),
            title: "新会话".into(),
            native_session_id: None,
            native_session_path: None,
            archived: false,
            pinned: false,
            read_only: false,
            imported: false,
            updated_at: 1,
            preferences: SessionPreferences::default(),
        });
        view.models = view_models;
        view.model = Some(json!({"id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen", "provider": "acp:antigravity"}));

        let configured = vec!["gemini-4-hydrogen".to_string()];
        apply_provider_scope_to_view(&mut view, "gemini-魔方", Some(&configured), Some(&available));
        assert_eq!(view.models.len(), 1);
        assert_eq!(text(&view.models[0], "id"), "gemini-4-hydrogen");
        assert_eq!(text(&view.models[0], "provider"), "gemini-魔方");
        assert_eq!(view.model.as_ref().map(|m| text(m, "provider")).as_deref(), Some("gemini-魔方"));
    }

    #[test]
    fn normalizes_gemini_base_url_without_doubling_v1beta() {
        assert_eq!(super::super::providers::normalize_agy_base_url("http://139.9.157.145:5000/"), "http://139.9.157.145:5000");
        assert_eq!(super::super::providers::normalize_agy_base_url("http://139.9.157.145:5000/v1beta/"), "http://139.9.157.145:5000");
        assert_eq!(super::super::providers::normalize_agy_base_url("https://proxy.example/custom/v1beta"), "https://proxy.example/custom");
    }

    #[test]
    fn resolves_acp_permission_auto_replies_by_policy_and_tool_kind() {
        let read_req = json!({
            "toolCall": {
                "title": "File C:/Users/79988/Desktop/iris-analysis-report/outputs/metrics_summary.json",
                "rawInput": { "Path": "C:\\Users\\79988\\Desktop\\metrics.json", "StartLine": 801, "EndLine": 1600 }
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
            ]
        });
        let cmd_req = json!({
            "toolCall": {
                "title": "Get-ChildItem -Path C:\\Users\\79988\\Desktop",
                "rawInput": { "CommandLine": "Get-ChildItem -Path C:\\Users\\79988\\Desktop" }
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
            ]
        });

        let ask = HostToolsPolicy::default();
        assert_eq!(resolve_permission_auto_reply(&ask, &read_req), None);
        assert_eq!(resolve_permission_auto_reply(&ask, &cmd_req), None);

        let allow_read = HostToolsPolicy { permission: "allow_read".into(), ..HostToolsPolicy::default() };
        assert_eq!(
            resolve_permission_auto_reply(&allow_read, &read_req),
            Some(json!({ "outcome": "selected", "optionId": "allow_once" }))
        );
        assert_eq!(resolve_permission_auto_reply(&allow_read, &cmd_req), None);

        let allow_all = HostToolsPolicy { permission: "allow_all".into(), ..HostToolsPolicy::default() };
        assert_eq!(
            resolve_permission_auto_reply(&allow_all, &cmd_req),
            Some(json!({ "outcome": "selected", "optionId": "allow_once" }))
        );

        let deny = HostToolsPolicy { permission: "deny".into(), ..HostToolsPolicy::default() };
        assert_eq!(
            resolve_permission_auto_reply(&deny, &read_req),
            Some(json!({ "outcome": "selected", "optionId": "reject_once" }))
        );
    }

    #[test]
    fn normalizes_acp_usage_update_and_merges_prompt_breakdown() {
        let updated = merge_acp_usage_update(
            &Value::Null,
            &json!({ "sessionUpdate": "usage_update", "used": 13023, "size": 1048576 }),
        );
        assert_eq!(updated["tokens"], json!(13023));
        assert_eq!(updated["window"], json!(1048576));
        let pct = updated["percent"].as_f64().unwrap();
        assert!((pct - (13023.0 / 1048576.0 * 100.0)).abs() < 1e-6);

        let with_usage = merge_acp_prompt_usage(
            &updated,
            &json!({
                "inputTokens": 8345,
                "outputTokens": 678,
                "cachedReadTokens": 4000,
                "cachedWriteTokens": 0,
                "totalTokens": 13023
            }),
        );
        assert_eq!(with_usage["tokens"], json!(13023));
        assert_eq!(with_usage["usage"]["input"], json!(8345));
        assert_eq!(with_usage["usage"]["output"], json!(678));
        assert_eq!(with_usage["usage"]["cacheRead"], json!(4000));
        assert_eq!(with_usage["usage"]["cacheWrite"], json!(0));

        // Subsequent usage_update keeps breakdown intact while advancing tokens/percent.
        let next = merge_acp_usage_update(
            &with_usage,
            &json!({ "sessionUpdate": "usage_update", "used": 26046, "size": 1048576 }),
        );
        assert_eq!(next["tokens"], json!(26046));
        assert_eq!(next["usage"]["input"], json!(8345));
    }
}
