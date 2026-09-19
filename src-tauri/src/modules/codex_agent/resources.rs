use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    id: String,
    alias: String,
    base_url: String,
    encrypted_key: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceFile {
    version: u32,
    active_resource_id: String,
    resources: Vec<Resource>,
    #[serde(default)]
    last_models: HashMap<String, ModelChoice>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ModelChoice {
    model: String,
    effort: String,
}

impl Default for ResourceFile {
    /// 首次使用保留原生配置，不自动复制用户密钥。
    fn default() -> Self {
        Self {
            version: 1,
            active_resource_id: "native".into(),
            resources: Vec::new(),
            last_models: HashMap::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceView {
    id: String,
    alias: String,
    base_url: String,
    key_mask: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub provider: String,
    pub active_resource_id: String,
    resources: Vec<ResourceView>,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInput {
    id: String,
    alias: String,
    base_url: String,
    key: String,
}

/// 获取 Codex 原生目录，尊重 CODEX_HOME。
pub fn home() -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
        .ok_or("Codex 目录不可用".into())
}

/// 读取固定 provider 与选中的原生 profile，不返回认证内容。
fn native_config(root: &Path) -> Result<(String, toml::Value), String> {
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

/// 读取 Codev 独立档案，未知版本明确拒绝覆盖。
fn read_at(path: &Path) -> Result<ResourceFile, String> {
    let file: ResourceFile = match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "codev.json 格式无效，请检查资源档案")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ResourceFile::default()),
        Err(_) => return Err("无法读取 codev.json".into()),
    };
    if file.version != 1 {
        return Err("不支持的 codev.json 版本".into());
    }
    Ok(file)
}

/// 同目录临时文件原子替换，避免保存中断破坏档案。
fn write_at(path: &Path, file: &ResourceFile) -> Result<(), String> {
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

/// 使用当前 Windows 用户的 DPAPI 保护密钥，禁止明文落盘。
#[cfg(windows)]
fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("密钥保护失败：请在保存档案的 Windows 用户下使用，或重新录入密钥".into());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(result)
}

/// 未提供系统密钥保护的系统不以明文降级保存。
#[cfg(not(windows))]
fn crypt(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("资源密钥存储当前仅支持 Windows".into())
}

/// 校验 HTTP 地址，拒绝在 URL 中夹带认证信息。
fn validate_url(value: &str) -> Result<String, String> {
    let url = tauri::Url::parse(value.trim()).map_err(|_| "请输入有效 baseURL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("baseURL 仅支持不含账号、查询参数和片段的 HTTP(S) 地址".into());
    }
    Ok(value.trim().trim_end_matches('/').to_string())
}

/// 构造不含真实密钥的资源列表。
fn catalog(file: ResourceFile) -> Result<Catalog, String> {
    let (provider, config) = native_config(&home()?)?;
    let base_url = config
        .get("model_providers")
        .and_then(|p| p.get(&provider))
        .and_then(|p| p.get("base_url"))
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut resources = vec![ResourceView {
        id: "native".into(),
        alias: "原生资源".into(),
        base_url,
        key_mask: "沿用原生认证".into(),
    }];
    resources.extend(file.resources.into_iter().map(|r| ResourceView {
        id: r.id,
        alias: r.alias,
        base_url: r.base_url,
        key_mask: "••••••••".into(),
    }));
    Ok(Catalog {
        provider,
        active_resource_id: file.active_resource_id,
        resources,
        path: home()?.join("codev.json").to_string_lossy().to_string(),
    })
}

/// 列出凭据档案，密文与明文均不发送到前端。
#[tauri::command]
pub fn codex_resources_list() -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    catalog(read_at(&home()?.join("codev.json"))?)
}

/// 新增或编辑档案；空 key 仅用于保留已有密钥，编辑不切换运行中资源。
#[tauri::command]
pub fn codex_resources_save(input: ResourceInput) -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    if input.id.is_empty() || input.id == "native" || input.alias.trim().is_empty() {
        return Err("请填写资源别名".into());
    }
    let base_url = validate_url(&input.base_url)?;
    let path = home()?.join("codev.json");
    let mut file = read_at(&path)?;
    let old = file.resources.iter().find(|r| r.id == input.id);
    let encrypted_key = if input.key.trim().is_empty() {
        old.ok_or("新资源必须填写 API key")?.encrypted_key.clone()
    } else {
        crypt(input.key.trim().as_bytes(), false)?
    };
    let resource = Resource {
        id: input.id.clone(),
        alias: input.alias.trim().into(),
        base_url,
        encrypted_key,
    };
    if let Some(index) = file.resources.iter().position(|r| r.id == input.id) {
        file.resources[index] = resource;
    } else {
        file.resources.push(resource);
    }
    write_at(&path, &file)?;
    catalog(file)
}

/// 删除未选中的档案，当前资源必须先切换后删除。
#[tauri::command]
pub fn codex_resources_delete(id: String) -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let path = home()?.join("codev.json");
    let mut file = read_at(&path)?;
    if id == "native" || id == file.active_resource_id {
        return Err("当前资源不能删除，请先切换资源".into());
    }
    file.resources.retain(|r| r.id != id);
    write_at(&path, &file)?;
    catalog(file)
}

/// 用户主动探测模型目录，不发送生成请求，目录可达不代表模型调用一定可用。
#[tauri::command]
pub async fn codex_resources_probe(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resource = {
            let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
            read_at(&home()?.join("codev.json"))?
                .resources
                .into_iter()
                .find(|r| r.id == id)
                .ok_or("请先保存自定义资源")?
        };
        let key =
            String::from_utf8(crypt(&resource.encrypted_key, true)?).map_err(|_| "密钥解码失败")?;
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

/// 握手成功后记住已生效的资源，失败时不改写选择。
pub fn commit(id: &str) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let path = home()?.join("codev.json");
    let mut file = read_at(&path)?;
    if id != "native" && !file.resources.iter().any(|r| r.id == id) {
        return Err("资源档案已不存在".into());
    }
    if file.active_resource_id == id {
        return Ok(());
    }
    file.active_resource_id = id.into();
    write_at(&path, &file)
}

/// 读取当前资源与 provider 对应的最近模型，不覆盖已有线程模型。
pub fn last_model(id: &str, provider: &str) -> Result<Option<ModelChoice>, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    Ok(read_at(&home()?.join("codev.json"))?
        .last_models
        .get(&format!("{provider}/{id}"))
        .cloned())
}

/// 保存最近选择的模型与思考等级，供新建线程继承。
#[tauri::command]
pub fn codex_resources_model(
    id: String,
    provider: String,
    choice: ModelChoice,
) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let path = home()?.join("codev.json");
    let mut file = read_at(&path)?;
    file.last_models.insert(format!("{provider}/{id}"), choice);
    write_at(&path, &file)
}

/// 仅为目标子进程覆盖固定 provider 的地址与认证，不写原生配置。
pub fn configure(
    command: &mut Command,
    id: Option<&str>,
) -> Result<(String, String, Option<String>), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    configure_at(command, id, &home()?)
}

/// 从指定目录加载启动快照，测试可隔离于真实用户目录。
pub(super) fn configure_at(
    command: &mut Command,
    id: Option<&str>,
    root: &Path,
) -> Result<(String, String, Option<String>), String> {
    let file = read_at(&root.join("codev.json"))?;
    let id = id.unwrap_or(&file.active_resource_id).to_string();
    let (provider, config) = native_config(root)?;
    let mut overrides = vec![(
        "model_provider".to_string(),
        toml::Value::String(provider.clone()),
    )];
    let mut secret = None;
    if id != "native" {
        if !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("原生 provider 名称不适合启动参数覆盖，请使用原生资源".into());
        }
        let resource = file
            .resources
            .iter()
            .find(|r| r.id == id)
            .ok_or("资源档案不存在")?;
        let definition = config
            .get("model_providers")
            .and_then(|p| p.get(&provider))
            .and_then(toml::Value::as_table)
            .cloned()
            .unwrap_or_default();
        if definition.contains_key("auth") || definition.contains_key("experimental_bearer_token") {
            return Err(
                "当前原生 provider 使用额外认证配置，暂不支持仅通过 baseURL/key 切换".into(),
            );
        }
        if definition
            .get("wire_api")
            .and_then(toml::Value::as_str)
            .is_some_and(|api| api != "responses")
        {
            return Err("资源切换当前要求原生 provider 使用 Responses 协议".into());
        }
        for field in ["http_headers", "env_http_headers"] {
            if definition
                .get(field)
                .and_then(toml::Value::as_table)
                .is_some_and(|headers| {
                    headers.keys().any(|key| {
                        ["authorization", "x-api-key", "api-key"]
                            .contains(&key.to_ascii_lowercase().as_str())
                    })
                })
            {
                return Err("原生 provider 含自定义认证头，暂不支持仅通过 baseURL/key 切换".into());
            }
        }
        let key =
            String::from_utf8(crypt(&resource.encrypted_key, true)?).map_err(|_| "密钥解码失败")?;
        command.env("CODEV_CODEX_RESOURCE_KEY", &key);
        secret = Some(key);
        for (field, value) in [
            ("base_url", toml::Value::String(resource.base_url.clone())),
            (
                "env_key",
                toml::Value::String("CODEV_CODEX_RESOURCE_KEY".into()),
            ),
            ("requires_openai_auth", toml::Value::Boolean(false)),
        ] {
            overrides.push((format!("model_providers.{provider}.{field}"), value));
        }
    }
    for (key, value) in overrides {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    Ok((id, provider, secret))
}

/// 构建只含假密钥的隔离资源档案用于原生进程测试。
#[cfg(test)]
pub(super) fn fake_resource(root: &Path) {
    let mut file = ResourceFile::default();
    file.resources.push(Resource {
        id: "fake".into(),
        alias: "QA".into(),
        base_url: "http://127.0.0.1:1/qa/v1".into(),
        encrypted_key: crypt(b"fake-codev-resource", false).unwrap(),
    });
    write_at(&root.join("codev.json"), &file).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    /// URL 认证和查询参数不能绕过独立 key 字段进入档案。
    #[test]
    fn url_validation() {
        assert!(validate_url("https://example.com/v1/").is_ok());
        assert!(validate_url("https://key@example.com/v1").is_err());
        assert!(validate_url("https://example.com?key=secret").is_err());
    }
    /// 密文落盘往返不能包含原始 key。
    #[test]
    #[cfg(windows)]
    fn encrypted_roundtrip_and_atomic_store() {
        let key = b"codev-fake-key-for-test";
        let encrypted = crypt(key, false).unwrap();
        assert_ne!(encrypted, key);
        assert_eq!(crypt(&encrypted, true).unwrap(), key);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codev.json");
        let mut file = ResourceFile::default();
        file.resources.push(Resource {
            id: "test".into(),
            alias: "Test".into(),
            base_url: "https://example.com/v1".into(),
            encrypted_key: encrypted,
        });
        write_at(&path, &file).unwrap();
        file.active_resource_id = "test".into();
        write_at(&path, &file).unwrap();
        assert_eq!(read_at(&path).unwrap().active_resource_id, "test");
        assert!(!std::fs::read_to_string(path)
            .unwrap()
            .contains(std::str::from_utf8(key).unwrap()));
    }
}
