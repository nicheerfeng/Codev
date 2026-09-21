use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());
static PENDING_SWITCH: Mutex<Option<Vec<(PathBuf, Option<Vec<u8>>)>>> = Mutex::new(None);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    id: String,
    alias: String,
    base_url: String,
    #[serde(default)]
    key: String,
    /// 兼容旧版 codev.json；新写入不再生成该字段。
    #[serde(rename = "encryptedKey", default, skip_serializing)]
    legacy_encrypted_key: Option<Vec<u8>>,
}

/// 读取资源明文 key，并仅为旧档案执行一次兼容解密。
fn resource_key(resource: &Resource) -> Result<String, String> {
    if !resource.key.trim().is_empty() { return Ok(resource.key.clone()); }
    if let Some(bytes) = resource.legacy_encrypted_key.as_ref() {
        return String::from_utf8(crypt(bytes, true)?).map_err(|_| "密钥解码失败".into());
    }
    Ok(String::new())
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
    let mut file: ResourceFile = match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "codev.json 格式无效，请检查资源档案")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ResourceFile::default()),
        Err(_) => return Err("无法读取 codev.json".into()),
    };
    if file.version != 1 {
        return Err("不支持的 codev.json 版本".into());
    }
    let mut migrated = false;
    for resource in &mut file.resources {
        if resource.key.trim().is_empty() {
            if let Some(bytes) = resource.legacy_encrypted_key.take() {
                resource.key = String::from_utf8(crypt(&bytes, true)?).map_err(|_| "密钥解码失败")?;
                migrated = true;
            }
        }
    }
    if migrated { write_at(path, &file)?; }
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
        alias: "初始配置".into(),
        base_url,
        key_mask: "key：*".into(),
    }];
    // native 的地址始终来自当前 config.toml，codev.json 只保存用户别名。
    if let Some(current) = file.resources.iter().find(|r| r.id == "native") {
        resources[0].alias = current.alias.clone();
    }
    resources.extend(file.resources.into_iter().filter(|r| r.id != "native").map(|r| ResourceView {
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

/// 编辑资源时返回已有 API key；账号登录没有 API key 时返回空值。
#[tauri::command]
pub fn codex_resources_key(id: String) -> Result<String, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let root = home()?;
    let file = read_at(&root.join("codev.json"))?;
    if id == "native" {
        // native 永远以当前 config.toml bearer token 为准，不读取旧 native 档案 key。
        let (provider, config) = native_config(&root)?;
        if let Some(key) = config.get("model_providers").and_then(|items| items.get(&provider)).and_then(|item| item.get("experimental_bearer_token")).and_then(toml::Value::as_str).filter(|value| !value.trim().is_empty()) {
            return Ok(key.to_string());
        }
    }
    if let Some(resource) = file.resources.iter().find(|resource| resource.id == id) {
        return resource_key(resource);
    }
    if id != "native" { return Err("资源档案不存在".into()); }
    // 第三方资源的实际认证来源是 config.toml 顶层 bearer token；登录账号才回退 auth.json。
    let auth = match std::fs::read(root.join("auth.json")) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| "auth.json 格式无效")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err("无法读取 auth.json".into()),
    };
    Ok(auth.get("OPENAI_API_KEY").and_then(serde_json::Value::as_str).unwrap_or("").to_string())
}

/// 新增或编辑档案；空 key 仅用于保留已有密钥，编辑不切换运行中资源。
#[tauri::command]
pub fn codex_resources_save(input: ResourceInput) -> Result<Catalog, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    if input.id.is_empty() || input.alias.trim().is_empty() {
        return Err("请填写资源别名".into());
    }
    let base_url = validate_url(&input.base_url)?;
    let path = home()?.join("codev.json");
    let mut file = read_at(&path)?;
    let old = file.resources.iter().find(|r| r.id == input.id);
    let key = if input.key.trim().is_empty() {
        if let Some(old) = old {
            resource_key(old)?
        } else if input.id == "native" {
            let root = home()?;
            let key = (|| {
                let (provider, config) = native_config(&root).ok()?;
                if let Some(value) = config.get("model_providers").and_then(|items| items.get(&provider)).and_then(|item| item.get("experimental_bearer_token")).and_then(toml::Value::as_str) {
                    if !value.trim().is_empty() { return Some(value.to_owned()); }
                }
                let value: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("auth.json")).ok()?).ok()?;
                value.get("OPENAI_API_KEY")?.as_str().map(str::to_owned)
            })().filter(|key| !key.trim().is_empty()).ok_or("当前配置没有可保存的 API key，请填写密钥")?;
            key
        } else { return Err("新资源必须填写 API key".into()); }
    } else {
        input.key.trim().to_string()
    };
    let resource = Resource {
        id: input.id.clone(),
        alias: input.alias.trim().into(),
        base_url,
        key,
        legacy_encrypted_key: None,
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

/// 查询所选渠道的模型 ID 与名称，不发起生成调用，也不向前端传递密钥。
#[tauri::command]
pub async fn codex_resources_models(id: String) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (base_url, key) = if id == "native" {
            let root = home()?;
            let (_, config) = native_config(&root)?;
            let base = config.get("model_providers").and_then(|p| p.get(config.get("model_provider").and_then(toml::Value::as_str).unwrap_or("openai"))).and_then(|p| p.get("base_url")).and_then(toml::Value::as_str).unwrap_or("").to_string();
            (base, codex_resources_key("native".into())?)
        } else {
            let catalog = codex_resources_list()?;
            let resource = catalog.resources.iter().find(|r| r.id == id).ok_or("资源档案不存在")?;
            (resource.base_url.clone(), codex_resources_key(id.clone())?)
        };
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
            resource_key(&resource)?;
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
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("配置路径无效")?).map_err(|_| "无法创建配置临时文件")?;
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
            if let Some(bytes) = bytes { write_bytes(path, bytes)?; }
            else if path.exists() { std::fs::remove_file(path).map_err(|_| "无法恢复配置状态")?; }
        }
    }
    *pending = None;
    Ok(())
}

/// 应用资源时同步官方配置和认证文件，所有历史快照只留在内存。
pub fn apply_resource(id: &str, model: &str) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "资源存储锁不可用")?;
    let root = home()?;
    apply_resource_at(&root, id, model)
}

/// 使用指定根目录执行同步，便于用假密钥隔离验证。
pub(super) fn apply_resource_at(root: &Path, id: &str, model: &str) -> Result<(), String> {
    let (provider, config) = native_config(root)?;
    let resource_path = root.join("codev.json");
    let mut file = read_at(&resource_path)?;
    if !file.resources.iter().any(|r| r.id == "native") {
        let auth: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("auth.json")).map_err(|_| "无法读取当前 auth.json")?).map_err(|_| "auth.json 格式无效")?;
        let key = auth.get("OPENAI_API_KEY").and_then(serde_json::Value::as_str).filter(|key| !key.is_empty()).ok_or("当前资源没有 API key，请先保存资源")?;
        let base_url = config.get("model_providers").and_then(|p| p.get(&provider)).and_then(|p| p.get("base_url")).and_then(toml::Value::as_str).unwrap_or("");
        file.resources.push(Resource { id: "native".into(), alias: "初始配置".into(), base_url: base_url.into(), key: key.to_string(), legacy_encrypted_key: None });
    }
    let stored = file.resources.iter().find(|r| r.id == id).ok_or("资源档案不存在")?;
    // native 的 base/key 以当前 config.toml 为准，避免 codev.json 中的历史快照污染运行时。
    let native_base = config.get("model_providers").and_then(|p| p.get(&provider)).and_then(|p| p.get("base_url")).and_then(toml::Value::as_str).unwrap_or("");
    let native_key = config.get("model_providers").and_then(|items| items.get(&provider)).and_then(|item| item.get("experimental_bearer_token")).and_then(toml::Value::as_str).unwrap_or("");
    let (base_url, key) = if id == "native" {
        (native_base.to_string(), if !native_key.is_empty() { native_key.to_string() } else { resource_key(stored)? })
    } else {
        (stored.base_url.clone(), resource_key(stored)?)
    };
    let path = root.join("config.toml");
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("无法读取 config.toml".into()),
    };
    let mut doc = source.parse::<toml_edit::DocumentMut>().map_err(|_| "config.toml 格式无效")?;
    doc["model"] = toml_edit::value(model);
    doc.remove("model_reasoning_effort");
    doc["cli_auth_credentials_store"] = toml_edit::value("file");
    doc["forced_login_method"] = toml_edit::value("api");
    let bearer_resource = !key.trim().is_empty();
    let definition = &mut doc["model_providers"][&provider];
    definition["base_url"] = toml_edit::value(&base_url);
    definition["wire_api"] = toml_edit::value("responses");
    definition["requires_openai_auth"] = toml_edit::value(!bearer_resource);
    if let Some(table) = definition.as_table_mut() {
        for field in ["env_key", "auth"] { table.remove(field); }
        if bearer_resource { table["experimental_bearer_token"] = toml_edit::value(&key); }
        else { table.remove("experimental_bearer_token"); }
        for field in ["http_headers", "env_http_headers"] {
            if let Some(headers) = table.get_mut(field).and_then(|item| item.as_table_like_mut()) {
                let keys: Vec<String> = headers.iter().filter(|(name, _)| ["authorization", "x-api-key", "api-key"].contains(&name.to_ascii_lowercase().as_str())).map(|(name, _)| name.to_string()).collect();
                for name in keys { headers.remove(&name); }
            }
        }
    }
    if let Some(profile) = doc.get("profile").and_then(|item| item.as_str()).map(str::to_owned) {
        doc["profiles"][&profile]["model"] = toml_edit::value(model);
        if let Some(table) = doc["profiles"][&profile].as_table_mut() { table.remove("model_reasoning_effort"); }
    }
    file.last_models.insert(format!("{provider}/{id}"), ModelChoice { model: model.into(), effort: String::new() });
    let paths = [path.clone(), root.join("auth.json"), resource_path.clone()];
    let snapshots = paths.iter().map(|path| match std::fs::read(path) {
        Ok(bytes) => Ok((path.clone(), Some(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((path.clone(), None)),
        Err(_) => Err("无法读取切换前配置".to_string()),
    }).collect::<Result<Vec<_>, _>>()?;
    *PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")? = Some(snapshots);
    write_bytes(&path, doc.to_string().as_bytes())?;
    if !bearer_resource {
        write_bytes(&root.join("auth.json"), serde_json::json!({"OPENAI_API_KEY":key}).to_string().as_bytes())?;
    }
    write_at(&resource_path, &file)
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
        *PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")? = None;
        return Ok(());
    }
    file.active_resource_id = id.into();
    write_at(&path, &file)?;
    *PENDING_SWITCH.lock().map_err(|_| "切换锁不可用")? = None;
    Ok(())
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

/// 启动时读取已同步的配置文件，不向进程注入另一套认证。
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
    let (provider, _) = native_config(root)?;
    let auth: serde_json::Value = std::fs::read(root.join("auth.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let secret = auth.get("OPENAI_API_KEY").and_then(serde_json::Value::as_str).map(str::to_owned);
    command.env("CODEX_HOME", root);
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
        key: "fake-codev-resource".into(), legacy_encrypted_key: None,
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
    /// 资源档案直接保存明文 key，便于与当前 config.toml 保持一致。
    #[test]
    #[cfg(windows)]
    fn plain_key_atomic_store() {
        let key = "codev-fake-key-for-test";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codev.json");
        let mut file = ResourceFile::default();
        file.resources.push(Resource {
            id: "test".into(),
            alias: "Test".into(),
            base_url: "https://example.com/v1".into(),
            key: key.into(),
            legacy_encrypted_key: None,
        });
        write_at(&path, &file).unwrap();
        file.active_resource_id = "test".into();
        write_at(&path, &file).unwrap();
        assert_eq!(read_at(&path).unwrap().active_resource_id, "test");
        assert!(std::fs::read_to_string(path).unwrap().contains(key));
    }
}
