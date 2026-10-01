use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());
static PENDING_SWITCH: Mutex<Option<Vec<(PathBuf, Option<Vec<u8>>)>>> = Mutex::new(None);

/// 独立资源只保存别名、地址和明文密钥。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resource {
    alias: String,
    base_url: String,
    key: String,
}

/// 列表的当前别名由实际配置匹配得出，不写入资源文件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub provider: String,
    pub active_alias: String,
    resources: Vec<Resource>,
    path: String,
}

/// 获取 Codex 原生目录，尊重 CODEX_HOME。
pub fn home() -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
        .ok_or("Codex 目录不可用".into())
}

/// 读取 Codex 个人全局指令文件。
#[tauri::command]
pub fn codex_resources_read_instructions() -> Result<String, String> {
    let path = home()?.join("AGENTS.md");
    Ok(fs::read_to_string(path).unwrap_or_default())
}

/// 保存 Codex 个人全局指令文件；空内容删除文件。
#[tauri::command]
pub fn codex_resources_write_instructions(content: String) -> Result<(), String> {
    let path = home()?.join("AGENTS.md");
    if content.trim().is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    } else {
        fs::write(
            path,
            if content.ends_with('\n') {
                content
            } else {
                format!("{content}\n")
            },
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 读取固定 provider 与选中的原生 profile，不返回认证内容。
fn read_config(root: &Path) -> Result<(String, toml::Value), String> {
    let path = root.join("config.toml");
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("无法读取 Codex config.toml".into()),
    };
    let config: toml::Value = toml::from_str(&text).map_err(|_| "Codex config.toml 格式无效")?;
    let profile = config
        .get("profile")
        .and_then(toml::Value::as_str)
        .and_then(|name| config.get("profiles")?.get(name));
    let provider = profile
        .and_then(|p| p.get("model_provider"))
        .or_else(|| config.get("model_provider"))
        .and_then(toml::Value::as_str)
        .unwrap_or("openai")
        .to_string();
    Ok((provider, config))
}

/// 从当前 provider 直接复制地址和密钥。
fn configured_resource(root: &Path) -> Result<(String, Resource), String> {
    let (provider, config) = read_config(root)?;
    let table = config
        .get("model_providers")
        .and_then(|items| items.get(&provider));
    Ok((
        provider,
        Resource {
            alias: "初始资源".into(),
            base_url: table
                .and_then(|t| t.get("base_url"))
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .into(),
            key: table
                .and_then(|t| t.get("experimental_bearer_token"))
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .into(),
        },
    ))
}

/// 仅在缺失或格式不符时用当前配置初始化；合法数组原样读取。
fn read_at(path: &Path) -> Result<Vec<Resource>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            if let Ok(resources) = serde_json::from_slice::<Vec<Resource>>(&bytes) {
                let mut aliases = HashSet::new();
                if resources
                    .iter()
                    .all(|r| !r.alias.trim().is_empty() && aliases.insert(&r.alias))
                {
                    return Ok(resources);
                }
                return Err("资源别名不能为空或重复".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法读取 codev.json".into()),
    }
    let (_, current) = configured_resource(path.parent().ok_or("资源目录无效")?)?;
    let resources = vec![current];
    write_at(path, &resources)?;
    Ok(resources)
}

/// 新组合只追加一次，并跳过所有已占用的初始资源别名。
fn sync_at(root: &Path) -> Result<Vec<Resource>, String> {
    let path = root.join("codev.json");
    let mut resources = read_at(&path)?;
    let (_, mut current) = configured_resource(root)?;
    if !resources
        .iter()
        .any(|r| r.base_url == current.base_url && r.key == current.key)
    {
        let mut number = 2;
        while resources.iter().any(|r| r.alias == current.alias) {
            current.alias = format!("初始资源{number}号");
            number += 1;
        }
        resources.push(current);
        write_at(&path, &resources)?;
    }
    Ok(resources)
}

/// 同目录临时文件原子替换，避免保存中断破坏档案。
fn write_at(path: &Path, file: &[Resource]) -> Result<(), String> {
    let parent = path.parent().ok_or("档案路径无效")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建 Codex 目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建档案临时文件")?;
    serde_json::to_writer_pretty(&mut temp, file).map_err(|_| "无法序列化资源档案")?;
    temp.flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "无法写入资源档案")?;
    temp.persist(path).map_err(|_| "无法保存 codev.json")?;
    Ok(())
}

/// 直接返回资源及与当前配置匹配的别名，不改写资源。
fn catalog(resources: Vec<Resource>) -> Result<Catalog, String> {
    let root = home()?;
    let (provider, current) = configured_resource(&root)?;
    let active_alias = resources
        .iter()
        .find(|r| r.base_url == current.base_url && r.key == current.key)
        .map(|r| r.alias.clone())
        .unwrap_or_default();
    Ok(Catalog {
        provider,
        active_alias,
        resources,
        path: root.join("codev.json").to_string_lossy().into(),
    })
}

/// 重新加载时检查当前配置是否为尚未保存的新资源组合。
#[tauri::command]
pub fn codex_resources_list() -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    catalog(sync_at(&home()?)?)
}

/// 按原别名编辑或新增资源，所有资源使用相同规则。
#[tauri::command]
pub fn codex_resources_save(
    input: Resource,
    original_alias: Option<String>,
) -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let path = home()?.join("codev.json");
    let mut resources = read_at(&path)?;
    let resource = Resource {
        alias: input.alias.trim().into(),
        ..input
    };
    if resource.alias.is_empty() {
        return Err("请填写资源别名".into());
    }
    if resources
        .iter()
        .any(|r| r.alias == resource.alias && Some(&r.alias) != original_alias.as_ref())
    {
        return Err("资源别名已存在，请使用其他名称".into());
    }
    if let Some(alias) = original_alias {
        let old = resources
            .iter_mut()
            .find(|r| r.alias == alias)
            .ok_or("资源不存在")?;
        *old = resource;
    } else {
        resources.push(resource);
    }
    write_at(&path, &resources)?;
    catalog(resources)
}

/// 删除所选别名对应的资源，不区分初始资源。
#[tauri::command]
pub fn codex_resources_delete(alias: String) -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let path = home()?.join("codev.json");
    let mut resources = read_at(&path)?;
    resources.retain(|r| r.alias != alias);
    write_at(&path, &resources)?;
    catalog(resources)
}

/// 按唯一别名读取资源，用于切换和目录查询。
fn resource_at(root: &Path, alias: &str) -> Result<Resource, String> {
    read_at(&root.join("codev.json"))?
        .into_iter()
        .find(|r| r.alias == alias)
        .ok_or("资源不存在".into())
}

/// 查询所选渠道的模型 ID 与名称，不发起生成调用，也不向前端传递密钥。
#[tauri::command]
pub async fn codex_resources_models(alias: String) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resource = resource_at(&home()?, &alias)?;
        let (base_url, key) = (resource.base_url, resource.key);
        if base_url.is_empty() { return Ok(Vec::new()); }
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).redirects(0).build();
        let mut request = agent.get(&format!("{}/models", base_url.trim_end_matches('/')));
        if !key.is_empty() { request = request.set("Authorization", &format!("Bearer {key}")); }
        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(status, _) => format!("渠道模型目录返回 HTTP {status}"),
            _ => "渠道模型目录连接失败或超时".to_string(),
        })?;
        let value: serde_json::Value = response.into_json().map_err(|_| "渠道模型目录不是 JSON 格式")?;
        let data = value.get("data").and_then(serde_json::Value::as_array).ok_or("渠道未返回标准模型目录")?;
        let ids: std::collections::HashSet<&str> = data.iter().filter_map(|item| item.get("id")?.as_str()).map(str::trim).collect();
        Ok(data.iter().filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim();
            if id.is_empty() { return None; }
            // 隐藏上游为同一模型生成的带编号 codex 别名，避免选择器暴露重复资源名。
            if let Some((base, suffix)) = id.rsplit_once('-') {
                let has_numbered_suffix = suffix.len() > 1
                    && suffix.chars().any(|ch| ch.is_ascii_digit())
                    && suffix.chars().any(|ch| ch.is_ascii_alphabetic())
                    && suffix.chars().all(|ch| ch.is_ascii_alphanumeric());
                if has_numbered_suffix && ids.contains(base) { return None; }
            }
            Some(serde_json::json!({ "id": id, "name": item.get("name").and_then(serde_json::Value::as_str).unwrap_or(id) }))
        }).collect())
    }).await.map_err(|error| error.to_string())?
}

/// 用户主动探测模型目录，不发送生成请求，目录可达不代表模型调用一定可用。
#[tauri::command]
pub async fn codex_resources_probe(alias: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resource = resource_at(&home()?, &alias)?;
        let key = &resource.key;
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(10))
            .redirects(0)
            .build();
        let result = agent
            .get(&format!("{}/models", resource.base_url))
            .set("Authorization", &format!("Bearer {key}"))
            .call();
        match result {
            Ok(response) => {
                let value: serde_json::Value = response
                    .into_json()
                    .map_err(|_| "上游已响应，但模型目录不是 JSON 格式")?;
                let count = value["data"]
                    .as_array()
                    .ok_or("上游已响应，但未返回标准模型目录")?
                    .len();
                Ok(format!("模型目录可达，共 {count} 个模型；未执行生成调用。"))
            }
            Err(ureq::Error::Status(404 | 405, _)) => {
                Ok("上游未提供 /models，无法通过模型目录判定调用是否可用。".into())
            }
            Err(ureq::Error::Status(status, _)) => Err(format!("模型目录探测返回 HTTP {status}")),
            Err(_) => Err("模型目录探测连接失败或超时，请检查地址与网络".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 单文件原子写入；临时文件替换后消失，不生成历史备份。
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("配置路径无效")?)
        .map_err(|_| "无法创建配置临时文件")?;
    temp.write_all(bytes).map_err(|_| "无法写入配置")?;
    temp.as_file().sync_all().map_err(|_| "无法保存配置")?;
    temp.persist(path).map_err(|_| "无法替换配置文件")?;
    Ok(())
}

/// 失败时恢复本次切换前的内存快照，不创建备份目录或文件。
#[tauri::command]
pub fn codex_resources_rollback() -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let mut pending = PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")?;
    if let Some(files) = pending.as_ref() {
        for (path, bytes) in files {
            if let Some(bytes) = bytes {
                write_bytes(path, bytes)?;
            } else if path.exists() {
                std::fs::remove_file(path).map_err(|_| "无法恢复配置状态")?;
            }
        }
    }
    *pending = None;
    Ok(())
}

/// 切换资源时直接把地址与明文密钥写入当前 provider。
pub fn apply_resource(alias: &str, model: &str) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    apply_resource_at(&home()?, alias, model)
}

/// 使用独立目录执行资源应用。
pub(super) fn apply_resource_at(root: &Path, alias: &str, model: &str) -> Result<(), String> {
    let (provider, _) = read_config(root)?;
    let stored = resource_at(root, alias)?;
    let path = root.join("config.toml");
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("无法读取 config.toml".into()),
    };
    let mut doc = source
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| "config.toml 格式无效")?;
    doc["model"] = toml_edit::value(model);
    doc.remove("model_reasoning_effort");
    let definition = &mut doc["model_providers"][&provider];
    definition["base_url"] = toml_edit::value(&stored.base_url);
    definition["wire_api"] = toml_edit::value("responses");
    definition["requires_openai_auth"] = toml_edit::value(false);
    if let Some(table) = definition.as_table_mut() {
        for field in ["env_key", "auth"] {
            table.remove(field);
        }
        table["experimental_bearer_token"] = toml_edit::value(&stored.key);
        for field in ["http_headers", "env_http_headers"] {
            if let Some(headers) = table
                .get_mut(field)
                .and_then(|item| item.as_table_like_mut())
            {
                let keys: Vec<String> = headers
                    .iter()
                    .filter(|(name, _)| {
                        ["authorization", "x-api-key", "api-key"]
                            .contains(&name.to_ascii_lowercase().as_str())
                    })
                    .map(|(name, _)| name.to_string())
                    .collect();
                for name in keys {
                    headers.remove(&name);
                }
            }
        }
    }
    if let Some(profile) = doc
        .get("profile")
        .and_then(|item| item.as_str())
        .map(str::to_owned)
    {
        doc["profiles"][&profile]["model"] = toml_edit::value(model);
        if let Some(table) = doc["profiles"][&profile].as_table_mut() {
            table.remove("model_reasoning_effort");
        }
    }
    let paths = [path.clone()];
    let snapshots = paths
        .iter()
        .map(|path| match std::fs::read(path) {
            Ok(bytes) => Ok((path.clone(), Some(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((path.clone(), None)),
            Err(_) => Err("无法读取切换前配置".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    *PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")? = Some(snapshots);
    write_bytes(&path, doc.to_string().as_bytes())
}

/// 握手成功后丢弃本次切换的回滚快照。
pub fn commit() -> Result<(), String> {
    *PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")? = None;
    Ok(())
}

/// 直接使用配置启动，按地址和密钥匹配资源别名。
pub fn configure(command: &mut Command) -> Result<(String, String, Option<String>), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    configure_at(command, &home()?)
}

/// 从指定目录加载当前配置，不再注入资源环境变量。
pub(super) fn configure_at(
    command: &mut Command,
    root: &Path,
) -> Result<(String, String, Option<String>), String> {
    let resources = sync_at(root)?;
    let (provider, current) = configured_resource(root)?;
    let alias = resources
        .iter()
        .find(|r| r.base_url == current.base_url && r.key == current.key)
        .ok_or("当前配置未匹配资源")?
        .alias
        .clone();
    command.env("CODEX_HOME", root);
    Ok((alias, provider, Some(current.key)))
}

/// 构建只含假密钥的隔离资源供原生进程测试。
#[cfg(test)]
pub(super) fn fake_resource(root: &Path) {
    write_at(
        &root.join("codev.json"),
        &[Resource {
            alias: "QA".into(),
            base_url: "http://127.0.0.1:1/qa/v1".into(),
            key: "fake-codev-resource".into(),
        }],
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 重载不重复导入；新组合跳过已有别名，改名与切换不丢失密钥。
    #[test]
    fn resource_reload_rename_and_switch() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.toml");
        let archive = root.path().join("codev.json");
        fs::write(&config, "model_provider = \"qa\"\n[model_providers.qa]\nbase_url = \"http://localhost:4000\"\nexperimental_bearer_token = \"key-a\"\n").unwrap();
        fs::write(&archive, "{\"version\":3,\"resources\":[]}").unwrap();
        let mut resources = sync_at(root.path()).unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].key, "key-a");
        assert_eq!(sync_at(root.path()).unwrap().len(), 1);
        resources.push(Resource {
            alias: "初始资源2号".into(),
            base_url: "other".into(),
            key: "other".into(),
        });
        write_at(&archive, &resources).unwrap();
        fs::write(
            &config,
            fs::read_to_string(&config)
                .unwrap()
                .replace("key-a", "key-b"),
        )
        .unwrap();
        let mut resources = sync_at(root.path()).unwrap();
        assert_eq!(resources.last().unwrap().alias, "初始资源3号");
        assert_eq!(sync_at(root.path()).unwrap().len(), 3);
        resources[2].alias = "我的渠道".into();
        write_at(&archive, &resources).unwrap();
        assert_eq!(sync_at(root.path()).unwrap()[2].alias, "我的渠道");
        apply_resource_at(root.path(), "初始资源", "qa-model").unwrap();
        let (_, current) = configured_resource(root.path()).unwrap();
        assert_eq!(current.key, "key-a");
        assert_eq!(sync_at(root.path()).unwrap().len(), 3);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&archive).unwrap()).unwrap();
        assert_eq!(json[0].as_object().unwrap().len(), 3);
        codex_resources_rollback().unwrap();
        assert_eq!(configured_resource(root.path()).unwrap().1.key, "key-b");
    }
}
