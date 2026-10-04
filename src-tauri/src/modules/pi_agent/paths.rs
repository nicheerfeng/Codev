use crate::modules::proc::hide_console;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 将路径转换为前端统一使用的正斜线格式。
pub fn canonical_display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 判断给定路径是否是可用文件。
pub fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

/// 返回 Pi 主目录，不含 sessions 子目录。
pub fn pi_home_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
}

/// 返回 Pi 原生会话目录。
pub fn pi_sessions_dir() -> Option<PathBuf> {
    pi_home_dir().map(|path| path.join("sessions"))
}

/// 将路径标准化后进行当前平台语义下的比较。
pub fn same_path(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        let value = value.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    normalize(left) == normalize(right)
}

/// 按自定义路径、PATH 和用户 npm 目录依次寻找 Pi。
pub fn resolve_pi_binary(custom_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = custom_path.map(str::trim).filter(|value| !value.is_empty()) {
        return existing_file(PathBuf::from(value))
            .ok_or_else(|| format!("Pi 可执行文件不存在：{value}"));
    }

    let names: &[&str] = if cfg!(windows) {
        &["pi.exe", "pi.cmd", "pi.bat", "pi.ps1", "pi"]
    } else {
        &["pi"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in names {
                if let Some(found) = existing_file(directory.join(name)) {
                    return Ok(found);
                }
            }
        }
    }

    #[cfg(windows)]
    if let Some(data) = dirs::data_dir() {
        for name in names {
            if let Some(found) = existing_file(data.join("npm").join(name)) {
                return Ok(found);
            }
        }
    }

    Err("未找到 Pi，请先安装 Pi Coding Agent 并确保 pi 位于 PATH".to_string())
}

/// 创建可直接使用 stdin/stdout 管道的 Pi 命令。
pub fn create_pi_command(path: &Path, args: &[String]) -> Command {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(windows)]
    let mut command = if extension == "cmd" || extension == "bat" {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]).arg(path).args(args);
        command
    } else if extension == "ps1" {
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
    } else {
        let mut command = Command::new(path);
        command.args(args);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(path);
        command.args(args);
        command
    };

    hide_console(&mut command);
    command
}

/// 执行 Pi 版本探测并提取首行版本号。
pub fn probe_binary(path: &Path) -> Result<String, String> {
    let output = create_pi_command(path, &["--version".to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Pi 版本探测失败：{}", output.status)
        } else {
            message
        });
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        Err("Pi 未返回版本号".to_string())
    } else {
        Ok(version)
    }
}
