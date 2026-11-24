use super::{metadata::display_path, pi_settings, registry};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn configured_home(var: &str, fallback: PathBuf, home: &Path) -> PathBuf {
    match std::env::var_os(var) {
        Some(value) if !value.is_empty() => {
            let path = PathBuf::from(value);
            match path.strip_prefix("~") {
                Ok(rest) => home.join(rest),
                Err(_) => path,
            }
        }
        _ => fallback,
    }
}

fn collect_skills(root: &Path, source: &str, items: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.join("SKILL.md").is_file() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        items.push(json!({ "name": name, "path": display_path(&path), "source": source }));
    }
}

pub fn skills(harness: &str, cwd: Option<&str>) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("无法定位用户目录")?;
    let mut items = Vec::new();
    match harness {
        "acp:codex" => {
            let codex = configured_home("CODEX_HOME", home.join(".codex"), &home);
            collect_skills(&codex.join("skills"), "Codex 全局", &mut items);
            collect_skills(&codex.join("skills/.system"), "Codex 内置", &mut items);
            collect_skills(&home.join(".agents/skills"), "共享", &mut items);
            if let Some(cwd) = cwd {
                collect_skills(&Path::new(cwd).join(".codex/skills"), "项目", &mut items);
                collect_skills(&Path::new(cwd).join(".agents/skills"), "项目共享", &mut items);
            }
        }
        "acp:antigravity" => {
            let gemini = configured_home("GEMINI_HOME", home.join(".gemini"), &home);
            collect_skills(&gemini.join("config/skills"), "Antigravity 全局", &mut items);
            collect_skills(&gemini.join("antigravity-cli/skills"), "Antigravity CLI", &mut items);
            if let Some(cwd) = cwd {
                collect_skills(&Path::new(cwd).join(".gemini/skills"), "项目", &mut items);
                collect_skills(&Path::new(cwd).join(".agents/skills"), "项目共享", &mut items);
            }
        }
        _ => return Err("不支持的代理".into()),
    }
    items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({ "items": items }))
}

pub fn plugins(harness: &str) -> Result<Value, String> {
    let program = match harness {
        "acp:codex" => "codex",
        "acp:antigravity" => "agy",
        _ => return Err("不支持的代理".into()),
    };
    let binary = registry::resolve_binary(program).ok_or_else(|| format!("未找到 {program} 程序"))?;
    let args = ["plugin".into(), "list".into(), "--json".into()];
    let output = pi_settings::run_command_with_limit(&binary, &args, Duration::from_secs(15), 2 * 1024 * 1024)?;
    let data: Value = serde_json::from_str(&output).map_err(|e| format!("读取插件列表失败：{e}"))?;
    let plugins = data.as_array().or_else(|| data.get("installed").and_then(Value::as_array))
        .ok_or("插件列表格式不受支持")?;
    let items: Vec<Value> = plugins.iter().filter_map(|item| {
        let name = item.get("name").or_else(|| item.get("pluginId")).or_else(|| item.get("id"))?.as_str()?;
        let path = item.get("path").or_else(|| item.get("installPath")).and_then(Value::as_str).unwrap_or("");
        let origin = item.get("marketplaceName").and_then(Value::as_str).unwrap_or(program);
        let status = item.get("enabled").and_then(Value::as_bool).map(|v| if v { "已启用" } else { "已停用" });
        Some(json!({ "name": name, "path": path, "source": origin, "status": status }))
    }).collect();
    Ok(json!({ "items": items }))
}
