use super::protocol::*;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let direct = PathBuf::from(name);
    if direct.components().count() > 1 {
        return direct.is_file().then_some(direct);
    }
    let names = if cfg!(windows) && direct.extension().is_none() {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            format!("{name}.ps1"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(data) = dirs::data_dir() {
        paths.push(data.join("npm"));
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(local.join("agy/bin"));
    }
    for directory in paths {
        for candidate in &names {
            let path = directory.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// No shell interpolation: Windows command wrappers are quoted as a complete /C command.
pub fn command_for(path: &Path, args: &[String]) -> Command {
    #[cfg(windows)]
    let mut command = {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext == "ps1" {
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(path)
                .args(args);
            command
        } else if ext == "cmd" || ext == "bat" {
            let mut command = Command::new("cmd.exe");
            // cmd.exe treats metacharacters inside a quoted argument literally. Refuse
            // command expansion syntax in configured arguments rather than evaluating it.
            let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
            let line = std::iter::once(quote(&path.to_string_lossy()))
                .chain(args.iter().map(|s| quote(s)))
                .collect::<Vec<_>>()
                .join(" ");
            command
                .args(["/D", "/V:OFF", "/S", "/C"])
                .raw_arg(format!("\"{line}\""));
            command
        } else {
            let mut command = Command::new(path);
            command.args(args);
            command
        }
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(path);
        command.args(args);
        command
    };
    crate::modules::proc::hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Install the pinned Codex adapter in an isolated directory, never globally.
fn managed_codex() -> Option<(PathBuf, PathBuf)> {
    let root = std::env::var_os("CODEV_AGENT_TOOLS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|path| path.join("codev-agent-tools")))?;
    let entry =
        root.join("codex-acp-2.6.0/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
    if !entry.is_file() {
        return None;
    }
    Some((resolve_binary("node")?, entry))
}

fn uses_default_codex_command(descriptor: &HarnessDescriptor) -> bool {
    descriptor.command == "npx"
        && descriptor.args
            == [
                "--yes".to_string(),
                "@agentclientprotocol/codex-acp@2.6.0".to_string(),
            ]
}

/// Resolve the actual program for one descriptor. A managed Codex adapter avoids
/// npx re-resolution on every session when using the default Codex command.
pub fn launch(descriptor: &HarnessDescriptor) -> Result<(PathBuf, Vec<String>), String> {
    if descriptor.id == "acp:codex" && uses_default_codex_command(descriptor) {
        if let Some((node, entry)) = managed_codex() {
            return Ok((node, vec![entry.to_string_lossy().into_owned()]));
        }
    }
    let binary = resolve_binary(&descriptor.command).ok_or_else(|| {
        format!(
            "找不到 {}。请安装对应命令行程序并完成登录，或在代理设置中填写程序路径。",
            descriptor.command
        )
    })?;
    Ok((binary, descriptor.args.clone()))
}

pub fn validate_descriptor(d: &HarnessDescriptor) -> Result<(), String> {
    if d.id.is_empty()
        || d.id.len() > 96
        || !d
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
    {
        return Err("代理标识只能包含字母、数字、冒号和短横线".into());
    }
    if d.command.trim().is_empty()
        || d.args.len() > 64
        || d.args
            .iter()
            .any(|s| s.contains(['\r', '\n', '\0', '%', '!']) || s.len() > 4096)
    {
        return Err("代理命令参数无效；请直接填写程序和参数，不要填写 Shell 脚本".into());
    }
    if d.command.contains(['\r', '\n', '\0', '%', '!']) {
        return Err("代理程序路径无效".into());
    }
    if d.kind != "nativePi" && d.kind != "acp" {
        return Err("代理类型必须是 nativePi 或 acp".into());
    }
    Ok(())
}

pub fn baseline_capabilities(id: &str, kind: &str) -> Capabilities {
    if kind == "nativePi" || id == "pi" {
        Capabilities {
            supports_resume: true,
            supports_fork: true,
            supports_thinking: true,
            supports_permission: false,
            supports_images: true,
            supports_file_mentions: true,
            supports_queue: true,
            supports_compaction: true,
            supports_model_selection: true,
            supports_skills: true,
            supports_extension_ui: true,
            supports_context_usage: true,
        }
    } else {
        Capabilities {
            supports_resume: true,
            supports_fork: false,
            supports_thinking: id == "acp:codex",
            supports_permission: true,
            supports_images: true,
            supports_file_mentions: true,
            supports_queue: true,
            supports_compaction: false,
            supports_model_selection: true,
            supports_skills: true,
            supports_extension_ui: false,
            supports_context_usage: false,
        }
    }
}

pub fn defaults() -> Vec<HarnessDescriptor> {
    [
        ("pi", "Pi", "nativePi", "pi", vec![]),
        (
            "acp:codex",
            "Codex",
            "acp",
            "npx",
            vec!["--yes", "@agentclientprotocol/codex-acp@2.6.0"],
        ),
        (
            "acp:antigravity",
            "Antigravity",
            "acp",
            "agy",
            vec!["acp", "--stdio"],
        ),
    ]
    .into_iter()
    .map(|(id, label, kind, command, args)| HarnessDescriptor {
        id: id.into(),
        display_name: label.into(),
        kind: kind.into(),
        command: command.into(),
        args: args.into_iter().map(str::to_string).collect(),
        installed: (id == "acp:codex" && managed_codex().is_some())
            || resolve_binary(command).is_some(),
        capabilities: baseline_capabilities(id, kind),
    })
    .collect()
}

fn codex_config_has_auth(codex_dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(codex_dir.join("config.toml")) else {
        return false;
    };
    let Ok(doc) = raw.parse::<toml::Table>() else {
        return false;
    };
    let Some(providers) = doc.get("model_providers").and_then(toml::Value::as_table) else {
        return false;
    };
    let check_provider = |table: &toml::Table| -> bool {
        for key in ["experimental_bearer_token", "api_key"] {
            if table
                .get(key)
                .and_then(toml::Value::as_str)
                .is_some_and(|v| !v.trim().is_empty())
            {
                return true;
            }
        }
        if let Some(env_key) = table
            .get("env_key")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if std::env::var_os(env_key).is_some_and(|v| !v.is_empty()) {
                return true;
            }
        }
        false
    };
    if let Some(active) = doc
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(table) = providers.get(active).and_then(toml::Value::as_table) {
            if check_provider(table) {
                return true;
            }
        }
    }
    providers
        .values()
        .filter_map(toml::Value::as_table)
        .any(check_provider)
}

pub fn diagnose_harness(d: &HarnessDescriptor) -> serde_json::Value {
    let resolved = launch(d)
        .ok()
        .map(|(p, _)| super::metadata::display_path(&p));
    let node_path = resolve_binary("node").map(|p| super::metadata::display_path(&p));
    let managed = d.id == "acp:codex" && managed_codex().is_some();
    let mut hints: Vec<String> = vec![];
    let verdict = match d.id.as_str() {
        "pi" => {
            let pi_home = super::history::pi_home();
            let has_models = pi_home
                .as_ref()
                .is_some_and(|p| p.join("models.json").is_file());
            if resolved.is_none() {
                hints.push(
                    "未找到 pi 可执行程序，请确认已全局安装 Pi CLI 或在下方填写完整路径。".into(),
                );
                if node_path.is_some() {
                    hints.push("已检测到 Node 运行时；若终端能运行 pi 但此处找不到，请检查 GUI PATH 与 npm 全局目录。".into());
                }
                "missing_binary"
            } else if !has_models {
                hints.push("已找到 Pi 程序；首次使用如未看到模型，请确认 ~/.pi/agent/models.json 或已在终端运行过 pi 登录。".into());
                "needs_config"
            } else {
                "ready"
            }
        }
        "acp:codex" => {
            let codex_dir = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|h| h.join(".codex")));
            let codex_auth = codex_dir
                .as_ref()
                .is_some_and(|dir| dir.join("auth.json").is_file() || codex_config_has_auth(dir));
            let has_api_key = std::env::var_os("OPENAI_API_KEY").is_some_and(|v| !v.is_empty());
            let codex_native = resolve_binary("codex").is_some();
            if resolved.is_none() {
                if node_path.is_none() {
                    hints.push("未检测到 Node.js，codex-acp 需要 Node 才可运行。".into());
                }
                if codex_native && !managed {
                    hints.push("检测到本机已安装 codex CLI，但缺少 codex-acp 桥接器；可运行 pnpm agent:prepare 准备托管适配器。".into());
                } else {
                    hints.push(
                        "未找到 Codex ACP 启动程序，请在下方配置或运行 pnpm agent:prepare。".into(),
                    );
                }
                "missing_binary"
            } else if !codex_auth && !has_api_key {
                hints.push("已检测到启动环境，但未在 ~/.codex/auth.json 或 OPENAI_API_KEY 发现凭证；如首次连接报错，请在终端运行 codex login。".into());
                "needs_auth"
            } else {
                "ready"
            }
        }
        "acp:antigravity" => {
            if resolved.is_none() {
                hints.push("未找到 agy 命令，请安装 Antigravity CLI 或填写完整路径（Windows 通常位于 %LOCALAPPDATA%\\agy\\bin）。".into());
                "missing_binary"
            } else {
                hints.push(
                    "凭证归 agy CLI 所有；如遇未登录提示，请在 CMD 运行 agy 完成 Google 登录。"
                        .into(),
                );
                "ready"
            }
        }
        _ => {
            if resolved.is_none() {
                hints.push(format!("未在 PATH 或配置路径中找到 {}", d.command));
                "missing_binary"
            } else {
                "ready"
            }
        }
    };
    serde_json::json!({
        "id": d.id,
        "displayName": d.display_name,
        "verdict": verdict,
        "installed": resolved.is_some(),
        "resolvedPath": resolved,
        "nodePath": node_path,
        "managedCodex": managed,
        "hints": hints,
    })
}
