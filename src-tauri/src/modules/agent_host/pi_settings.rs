use super::{history, metadata::display_path};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn run_command(binary: &Path, args: &[String], timeout: std::time::Duration) -> Result<String, String> {
    use std::io::{Read, Seek};
    let mut output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stdout = output.try_clone().map_err(|e| e.to_string())?;
    let stderr = output.try_clone().map_err(|e| e.to_string())?;
    let mut command = super::registry::command_for(binary, args);
    command.stdin(std::process::Stdio::null()).stdout(stdout).stderr(stderr);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => Some(job),
        Err(_) if child.try_wait().ok().flatten().is_some() => None,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法保护子进程树：{error}"));
        }
    };
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if started.elapsed() > timeout {
            #[cfg(unix)]
            unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
            let _ = child.kill();
            let _ = child.wait();
            return Err("命令执行超时".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    output.rewind().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    output.take(16 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let message = String::from_utf8_lossy(&bytes).trim().to_string();
    if !status.success() { return Err(format!("命令执行失败：{message}")); }
    Ok(message)
}

fn models_path() -> Result<PathBuf, String> {
    history::pi_home()
        .map(|home| home.join("models.json"))
        .ok_or_else(|| "无法定位 Pi 配置目录".into())
}

pub fn read_models() -> Result<Value, String> {
    let path = models_path()?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取模型配置失败：{error}")),
    };
    Ok(json!({ "path": display_path(&path), "content": content }))
}

pub fn save_models(payload: &Value) -> Result<Value, String> {
    let path = models_path()?;
    let content = payload.get("content").and_then(Value::as_str).ok_or("缺少模型配置")?;
    let config: Value = serde_json::from_str(content).map_err(|e| format!("JSON 格式错误：{e}"))?;
    let object = config.as_object().ok_or("模型配置根节点必须是对象")?;
    if object.get("providers").is_some_and(|providers| !providers.is_object()) {
        return Err("providers 必须是对象".into());
    }
    let current = match std::fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取模型配置失败：{error}")),
    };
    let expected = payload.get("expected").and_then(Value::as_str);
    if current.as_deref() != expected {
        return Err("模型配置已被其他程序修改，请重新读取后再保存".into());
    }
    let parent = path.parent().ok_or("无法定位 Pi 配置目录")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| e.to_string())?;
    file.persist(&path).map_err(|e| e.error.to_string())?;
    Ok(json!({ "saved": true }))
}

fn collect_assets(root: &Path, source: &str, skills: bool, output: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        let valid = if skills {
            path.is_dir() && path.join("SKILL.md").is_file()
        } else {
            path.is_dir() || path.extension().and_then(|v| v.to_str()).is_some_and(|v| matches!(v, "ts" | "js" | "mjs" | "cjs"))
        };
        if valid {
            output.push(json!({ "name": name, "path": display_path(&path), "source": source }));
        }
    }
}

pub fn assets(kind: &str, workspace: Option<&str>) -> Result<Value, String> {
    let home = history::pi_home().ok_or("无法定位 Pi 配置目录")?;
    let mut items = Vec::new();
    match kind {
        "skills" => {
            collect_assets(&home.join("skills"), "Pi 全局", true, &mut items);
            if let Some(home) = dirs::home_dir() {
                collect_assets(&home.join(".agents/skills"), "共享", true, &mut items);
            }
            if let Some(cwd) = workspace {
                collect_assets(&Path::new(cwd).join(".pi/skills"), "项目", true, &mut items);
            }
        }
        "plugins" => {
            collect_assets(&home.join("extensions"), "Pi 全局", false, &mut items);
            if let Some(cwd) = workspace {
                collect_assets(&Path::new(cwd).join(".pi/extensions"), "项目", false, &mut items);
            }
            if let Ok(content) = std::fs::read_to_string(home.join("settings.json")) {
                if let Ok(settings) = serde_json::from_str::<Value>(&content) {
                    if let Some(packages) = settings.get("packages").and_then(Value::as_array) {
                        for package in packages.iter().filter_map(Value::as_str) {
                            items.push(json!({ "name": package, "path": "", "source": "已配置包" }));
                        }
                    }
                }
            }
        }
        _ => return Err("不支持的资源类型".into()),
    }
    items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({ "items": items }))
}
