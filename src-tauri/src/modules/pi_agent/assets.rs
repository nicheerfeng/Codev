use super::paths::{canonical_display, create_pi_command, pi_home_dir, resolve_pi_binary};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAsset {
    name: String,
    path: String,
    source: String,
    summary: Option<String>,
}

const RECOMMENDED_NPM_PACKAGES: &[&str] = &[
    "pi-mcp-adapter",
    "pi-lens",
    "pi-subagents",
    "@ogulcancelik/pi-codex-subagents",
    "pi-intercom",
    "pi-feishu-lark",
    "pi-hide-providers",
    "pi-rename-session",
];
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// 扫描 Pi 技能或插件目录，返回只读展示所需的轻量元数据。
#[tauri::command]
pub fn pi_agent_list_assets(kind: String) -> Result<Vec<PiAsset>, String> {
    let mut assets = Vec::new();
    match kind.as_str() {
        "skills" => {
            let home = dirs::home_dir().ok_or("无法定位用户目录")?;
            collect_named_dirs(
                &home.join(".pi").join("agent").join("skills"),
                "Pi 技能",
                &mut assets,
            );
            collect_named_dirs(
                &home.join(".agents").join("skills"),
                "共享技能",
                &mut assets,
            );
        }
        "plugins" => {
            let agent = pi_home_dir().ok_or("无法定位 Pi 目录")?;
            collect_extension_assets(&agent.join("extensions"), "自研扩展", &mut assets);
            collect_package_assets(&agent, &mut assets);
        }
        _ => return Err("kind 必须是 skills 或 plugins".into()),
    }
    assets.sort_by(|left, right| {
        left.source
            .to_lowercase()
            .cmp(&right.source.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(assets)
}

fn is_extension_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("ts" | "js" | "mjs" | "cjs")
    )
}

pub(crate) fn asset_summary(path: &Path) -> Option<String> {
    if path.is_file() {
        return read_preview(path).and_then(summarize_text);
    }
    for file in [
        "SKILL.md",
        "skill.md",
        "README.md",
        "README.txt",
        "package.json",
    ] {
        let candidate = path.join(file);
        if !candidate.is_file() {
            continue;
        }
        if let Some(summary) = read_preview(&candidate).and_then(summarize_text) {
            return Some(summary);
        }
    }
    None
}

fn read_preview(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buffer = vec![0u8; 8192];
    let count = file.read(&mut buffer).ok()?;
    String::from_utf8(buffer[..count].to_vec()).ok()
}

fn summarize_text(text: String) -> Option<String> {
    let trimmed = if let Ok(value) = serde_json::from_str::<Value>(&text) {
        value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        skill_frontmatter_description(&text).unwrap_or_default()
    };
    let compact: String = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact)
    }
}

pub(crate) fn skill_frontmatter_description(text: &str) -> Option<String> {
    let rest = text.trim_start();
    let body = rest.strip_prefix("---")?;
    let body = body
        .strip_prefix('\n')
        .or_else(|| body.strip_prefix("\r\n"))?;
    let end = body.find("\n---").or_else(|| body.find("\r\n---"))?;
    yaml_description(&body[..end])
}

fn yaml_description(frontmatter: &str) -> Option<String> {
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();
        if !trimmed.starts_with("description:") {
            index += 1;
            continue;
        }
        let remainder = trimmed["description:".len()..].trim();
        if remainder.is_empty()
            || remainder == ">"
            || remainder == ">-"
            || remainder == "|"
            || remainder == "|-"
        {
            index += 1;
            let mut chunks = Vec::new();
            while index < lines.len() {
                let next = lines[index];
                if next.trim().is_empty() {
                    break;
                }
                let indent = next.len() - next.trim_start().len();
                if indent == 0 {
                    break;
                }
                chunks.push(next.trim());
                index += 1;
            }
            let value = chunks.join(" ");
            return if value.is_empty() { None } else { Some(value) };
        }
        return Some(unquote_yaml(remainder));
    }
    None
}

fn unquote_yaml(value: &str) -> String {
    let trimmed = value.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

fn push_asset(name: String, path: PathBuf, source: &str, assets: &mut Vec<PiAsset>) {
    let display = canonical_display(&path);
    if assets.iter().any(|item| item.path == display) {
        return;
    }
    assets.push(PiAsset {
        name,
        path: display,
        source: source.to_string(),
        summary: asset_summary(&path),
    });
}

fn collect_named_dirs(root: &Path, source: &str, assets: &mut Vec<PiAsset>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        push_asset(name, path, source, assets);
    }
}

fn collect_extension_assets(root: &Path, source: &str, assets: &mut Vec<PiAsset>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            push_asset(name, path, source, assets);
        } else if is_extension_file(&path) {
            let label = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&name)
                .to_string();
            push_asset(label, path, source, assets);
        }
    }
}

fn package_spec_name(spec: &str) -> Option<String> {
    let name = spec.strip_prefix("npm:").unwrap_or(spec).trim();
    if name.is_empty() || name.starts_with('.') || name.contains("..") {
        return None;
    }
    Some(name.to_string())
}

fn package_dir(npm: &Path, spec: &str) -> Option<PathBuf> {
    let name = package_spec_name(spec)?;
    Some(
        name.split('/')
            .fold(npm.to_path_buf(), |acc, part| acc.join(part)),
    )
}

fn collect_package_assets(agent: &Path, assets: &mut Vec<PiAsset>) {
    let settings = fs::read_to_string(agent.join("settings.json")).ok();
    let Some(value) = settings.and_then(|text| serde_json::from_str::<Value>(&text).ok()) else {
        return;
    };
    let Some(packages) = value.get("packages").and_then(Value::as_array) else {
        return;
    };
    let npm = agent.join("npm").join("node_modules");
    for item in packages {
        let Some(spec) = item.as_str() else {
            continue;
        };
        let Some(path) = package_dir(&npm, spec) else {
            continue;
        };
        if !path.exists() {
            continue;
        }
        let name = package_spec_name(spec).unwrap_or_else(|| spec.to_string());
        push_asset(name, path, "第三方包", assets);
    }
}

pub(crate) fn recommended_npm_package(name: &str) -> Option<&'static str> {
    RECOMMENDED_NPM_PACKAGES
        .iter()
        .copied()
        .find(|item| item.eq_ignore_ascii_case(name.trim()))
}

pub(crate) fn collect_package_specs(agent: &Path) -> Vec<String> {
    let settings = fs::read_to_string(agent.join("settings.json")).ok();
    let Some(value) = settings.and_then(|text| serde_json::from_str::<Value>(&text).ok()) else {
        return Vec::new();
    };
    let Some(packages) = value.get("packages").and_then(Value::as_array) else {
        return Vec::new();
    };
    packages
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn wait_child_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("安装超时，请稍后重试或复制命令手动安装".to_string());
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn command_output_text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_string()
}

/// 列出 settings.json 里的 packages，即使磁盘上还没下完也能标已安装。
#[tauri::command]
pub fn pi_agent_list_package_specs() -> Result<Vec<String>, String> {
    let agent = pi_home_dir().ok_or("无法定位 Pi 目录")?;
    Ok(collect_package_specs(&agent))
}

/// 一次性安装公开 npm 插件，不启动 RPC、不打断正在跑的会话。
#[tauri::command]
pub fn pi_agent_install_package(package: String) -> Result<String, String> {
    let name =
        recommended_npm_package(&package).ok_or_else(|| format!("未收录的推荐插件：{package}"))?;
    let path = resolve_pi_binary(None)?;
    let spec = format!("npm:{name}");
    let mut child = create_pi_command(&path, &["install".to_string(), spec.clone()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut reader) = stdout {
            let _ = reader.read_to_string(&mut text);
        }
        text
    });
    let stderr_handle = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut reader) = stderr {
            let _ = reader.read_to_string(&mut text);
        }
        text
    });
    let status = wait_child_with_timeout(&mut child, INSTALL_TIMEOUT)?;
    let stdout_text = stdout_handle.join().ok().unwrap_or_default();
    let stderr_text = stderr_handle.join().ok().unwrap_or_default();
    let stdout_text = command_output_text(stdout_text.as_bytes());
    let stderr_text = command_output_text(stderr_text.as_bytes());
    let combined = [stdout_text.as_str(), stderr_text.as_str()]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !status.success() {
        return Err(if combined.is_empty() {
            format!("pi install {spec} 失败：{status}")
        } else {
            combined
        });
    }
    Ok(if combined.is_empty() {
        format!("已安装 {spec}")
    } else {
        combined
    })
}
