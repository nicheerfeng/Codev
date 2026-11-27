mod catalog;
use super::{bridge::lock, coordinator::{Host, Runtime}, protocol::new_id};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

pub(super) const CODEX_OFFICIAL: &str = "@official";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

fn preference(harness: &str) -> Result<String, String> {
    match harness {
        "acp:codex" | "acp:antigravity" => Ok(format!("providers:{harness}")),
        _ => Err("不支持的代理".into()),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ProviderSettings {
    #[serde(default)]
    active: String,
    #[serde(default)]
    items: Vec<Provider>,
    #[serde(default)]
    native_models: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    legacy_imported: bool,
}

fn read(host: &Host, harness: &str) -> Result<ProviderSettings, String> {
    let key = preference(harness)?;
    Ok(lock(&host.store).preference(&key).map(serde_json::from_value).transpose().map_err(|e| e.to_string())?.unwrap_or_default())
}
fn write(host: &Host, harness: &str, settings: &ProviderSettings) -> Result<(), String> {
    lock(&host.store).set_preference(&preference(harness)?, &serde_json::to_value(settings).map_err(|e| e.to_string())?)
}

#[cfg(windows)]
mod secrets {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
    fn target(id: &str) -> Vec<u16> { format!("Codev/agent-provider/{id}").encode_utf16().chain(Some(0)).collect() }
    pub fn get(id: &str) -> Result<Option<String>, String> {
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target(id).as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(1168) { Ok(None) } else { Err(format!("读取系统凭据失败：{error}")) };
        }
        let bytes = unsafe { std::slice::from_raw_parts((*credential).CredentialBlob, (*credential).CredentialBlobSize as usize) }.to_vec();
        unsafe { CredFree(credential.cast()) };
        String::from_utf8(bytes).map(Some).map_err(|_| "系统凭据编码无效".into())
    }
    pub fn set(id: &str, value: &str) -> Result<(), String> {
        let mut name = target(id);
        let mut credential = CREDENTIALW::default();
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = name.as_mut_ptr();
        credential.CredentialBlobSize = value.len().try_into().map_err(|_| "密钥过长")?;
        credential.CredentialBlob = value.as_ptr() as *mut u8;
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        if unsafe { CredWriteW(&credential, 0) } == 0 { return Err(format!("保存系统凭据失败：{}", std::io::Error::last_os_error())); }
        Ok(())
    }
    pub fn delete(id: &str) -> Result<(), String> {
        if unsafe { CredDeleteW(target(id).as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1168) { return Err(format!("删除系统凭据失败：{error}")); }
        }
        Ok(())
    }
}
#[cfg(not(windows))]
mod secrets {
    pub fn get(_: &str) -> Result<Option<String>, String> { Err("此平台暂不支持系统凭据存储".into()) }
    pub fn set(_: &str, _: &str) -> Result<(), String> { Err("此平台暂不支持系统凭据存储".into()) }
    pub fn delete(_: &str) -> Result<(), String> { Err("此平台暂不支持系统凭据存储".into()) }
}

fn codex_config_path() -> Result<PathBuf, String> {
    let home = match std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => match dirs::home_dir() {
            Some(home) => home.join(".codex"),
            None => return Err("无法定位 Codex 配置目录".into()),
        },
    };
    Ok(home.join("config.toml"))
}

fn codex_native_config() -> Value {
    let path = match codex_config_path() { Ok(path) => path, Err(_) => return json!({ "status": "unavailable" }) };
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return json!({ "status": "missing" }),
        Err(_) => return json!({ "status": "unavailable" }),
    };
    parse_codex_native_config(&content)
}

fn parse_codex_native_config(content: &str) -> Value {
    let config = match toml::from_str::<toml::Value>(content) {
        Ok(config) => config,
        Err(_) => return json!({ "status": "invalid" }),
    };
    let profile = config.get("profile").and_then(toml::Value::as_str)
        .and_then(|name| config.get("profiles").and_then(|p| p.get(name)));
    let id = profile.and_then(|p| p.get("model_provider")).and_then(toml::Value::as_str)
        .or_else(|| config.get("model_provider").and_then(toml::Value::as_str)).unwrap_or("openai");
    let provider = config.get("model_providers").and_then(|v| v.get(id));
    let name = provider.and_then(|v| v.get("name")).and_then(toml::Value::as_str).unwrap_or(id);
    let base_url = provider.and_then(|v| v.get("base_url")).and_then(toml::Value::as_str)
        .and_then(|value| url::Url::parse(value).ok())
        .and_then(|mut value| {
            if !matches!(value.scheme(), "http" | "https") { return None; }
            let _ = value.set_username("");
            let _ = value.set_password(None);
            value.set_query(None);
            value.set_fragment(None);
            Some(value.to_string())
        });
    let has_key = provider.and_then(|v| v.get("experimental_bearer_token")).and_then(toml::Value::as_str).is_some_and(|s| !s.is_empty());
    json!({ "status": "read", "providerId": id, "providerName": name, "baseUrl": base_url, "hasKey": has_key,
        "revision": super::auth::hash(content),
        "model": profile.and_then(|p| p.get("model")).and_then(toml::Value::as_str)
            .or_else(|| config.get("model").and_then(toml::Value::as_str)) })
}

fn patch_codex_config(content: &str, payload: &Value) -> Result<String, String> {
    let mut doc = content.parse::<toml_edit::DocumentMut>().map_err(|_| "Codex 配置文件格式无效")?;
    let profile = doc.get("profile").and_then(toml_edit::Item::as_str).map(str::to_owned);
    let current = profile.as_deref().and_then(|name| doc.get("profiles").and_then(|p| p.get(name)))
        .and_then(|p| p.get("model_provider")).and_then(toml_edit::Item::as_str)
        .or_else(|| doc.get("model_provider").and_then(toml_edit::Item::as_str)).unwrap_or("openai").to_string();
    if payload.get("providerId").and_then(Value::as_str) != Some(current.as_str()) { return Err("Codex 当前供应商已发生变化，请重新读取配置".into()); }
    let model = payload.get("model").and_then(Value::as_str).unwrap_or("").trim();
    if model.is_empty() { return Err("请输入模型名称".into()); }
    if let Some(profile) = profile {
        let table = doc.get_mut("profiles").and_then(|p| p.get_mut(&profile))
            .and_then(toml_edit::Item::as_table_like_mut).ok_or("当前 Codex profile 不存在或格式无效")?;
        table.insert("model", toml_edit::value(model));
    } else {
        doc["model"] = toml_edit::value(model);
    }
    if current != "openai" {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("").trim();
        let base = payload.get("baseUrl").and_then(Value::as_str).unwrap_or("").trim();
        if name.is_empty() { return Err("请输入供应商名称".into()); }
        validate_base_url(base)?;
        let table = doc.get_mut("model_providers").and_then(|v| v.get_mut(&current))
            .and_then(toml_edit::Item::as_table_like_mut).ok_or("未找到当前供应商的配置表")?;
        table.insert("name", toml_edit::value(name));
        table.insert("base_url", toml_edit::value(base));
        let key = payload.get("apiKey").and_then(Value::as_str).unwrap_or("").trim();
        if key.contains(['\r', '\n']) { return Err("密钥不能包含换行".into()); }
        if !key.is_empty() {
            table.insert("experimental_bearer_token", toml_edit::value(key));
            table.insert("requires_openai_auth", toml_edit::value(false));
            table.remove("env_key");
            table.remove("auth");
            for field in ["http_headers", "env_http_headers"] {
                if let Some(headers) = table.get_mut(field).and_then(toml_edit::Item::as_table_like_mut) {
                    let names: Vec<_> = headers.iter().filter(|(name, _)| ["authorization", "x-api-key", "api-key"].contains(&name.to_ascii_lowercase().as_str())).map(|(name, _)| name.to_string()).collect();
                    for name in names { headers.remove(&name); }
                }
            }
        }
    }
    Ok(doc.to_string())
}

fn validate_base_url(base: &str) -> Result<(), String> {
    let url = url::Url::parse(base).map_err(|_| "Base URL 无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err("Base URL 必须是无凭据、无查询参数的 HTTP(S) 地址".into()); }
    Ok(())
}

pub fn save_codex_native(host: &Host, payload: &Value) -> Result<Value, String> {
    use std::io::Write;
    let path = codex_config_path()?;
    let content = std::fs::read_to_string(&path).map_err(|_| "无法读取 Codex 配置文件")?;
    let revision = payload.get("revision").and_then(Value::as_str).ok_or("缺少配置版本，请重新读取")?;
    if super::auth::hash(&content) != revision { return Err("Codex 配置已在外部更改，请重新读取后保存".into()); }
    let updated = patch_codex_config(&content, payload)?;
    let mut settings = read(host, "acp:codex")?;
    let previous = settings.native_models.clone();
    if let Some(provider) = payload["providerId"].as_str() {
        settings.native_models.insert(provider.to_owned(), model_catalog(payload, payload["model"].as_str().unwrap_or("")));
    }
    let parent = path.parent().ok_or("Codex 配置路径无效")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建配置临时文件")?;
    temp.write_all(updated.as_bytes()).and_then(|_| temp.as_file().sync_all()).map_err(|_| "无法写入 Codex 配置")?;
    if std::fs::read_to_string(&path).map_err(|_| "无法读取 Codex 配置文件")? != content { return Err("Codex 配置已在外部更改，请重新读取后保存".into()); }
    write(host, "acp:codex", &settings)?;
    if temp.persist(&path).is_err() {
        settings.native_models = previous;
        write(host, "acp:codex", &settings)?;
        return Err("无法替换 Codex 配置文件".into());
    }
    list(host, "acp:codex")
}

#[cfg(test)]
mod codex_config_tests {
    use super::{codex_native_config, parse_codex_native_config, patch_codex_config};
    use serde_json::json;

    #[test]
    fn reads_full_codex_document_without_exposing_secrets() {
        let config = r#"
model_provider = "custom"
model = "example-model"

[model_providers.custom]
name = "Example Relay"
base_url = "https://relay.example/v1"
experimental_bearer_token = "secret-token"

[plugins."example@marketplace"]
enabled = true

[projects.'d:\work\project']
trust_level = "trusted"
"#;
        let result = parse_codex_native_config(config);
        assert_eq!(result["status"], "read");
        assert_eq!(result["providerId"], "custom");
        assert_eq!(result["providerName"], "Example Relay");
        assert_eq!(result["model"], "example-model");
        assert_eq!(result["baseUrl"], "https://relay.example/v1");
        assert!(!result.to_string().contains("secret-token"));
    }

    #[test]
    fn reports_invalid_documents_and_redacts_url_credentials() {
        assert_eq!(parse_codex_native_config("model = [")["status"], "invalid");
        let result = parse_codex_native_config("model_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://user:secret@relay.example/v1?key=secret#fragment'\n");
        assert_eq!(result["baseUrl"], "https://relay.example/v1");
    }

    #[test]
    fn editing_native_provider_preserves_unrelated_settings_and_existing_key() {
        let original = "# user config\nmodel_provider = 'relay'\nmodel = 'old'\n\n[model_providers.relay]\nname = 'Relay'\nbase_url = 'https://old.example/v1'\nexperimental_bearer_token = 'keep-secret'\nwire_api = 'responses'\n\n[plugins.example]\nenabled = true\n";
        let updated = patch_codex_config(original, &json!({"providerId":"relay","name":"New Relay","baseUrl":"https://new.example/v1","model":"new-model","apiKey":""})).unwrap();
        let parsed: toml::Value = toml::from_str(&updated).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("new-model"));
        assert_eq!(parsed["model_providers"]["relay"]["experimental_bearer_token"].as_str(), Some("keep-secret"));
        assert_eq!(parsed["plugins"]["example"]["enabled"].as_bool(), Some(true));
        assert!(updated.contains("# user config"));
    }

    #[test]
    fn editing_selected_profile_and_replacing_key_uses_effective_provider() {
        let original = "model_provider = 'root'\nmodel = 'root-model'\nprofile = 'work'\n[profiles.work]\nmodel_provider = 'relay'\nmodel = 'old'\n[model_providers.relay]\nname = 'Relay'\nbase_url = 'https://old.example'\nenv_key = 'OLD_KEY'\nrequires_openai_auth = true\n";
        let updated = patch_codex_config(original, &json!({"providerId":"relay","name":"Relay","baseUrl":"https://new.example","model":"new","apiKey":"new-secret"})).unwrap();
        let parsed: toml::Value = toml::from_str(&updated).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("root-model"));
        assert_eq!(parsed["profiles"]["work"]["model"].as_str(), Some("new"));
        assert_eq!(parsed["model_providers"]["relay"]["experimental_bearer_token"].as_str(), Some("new-secret"));
        assert!(parsed["model_providers"]["relay"].get("env_key").is_none());
        assert_eq!(parse_codex_native_config(&updated)["providerId"], "relay");
    }

    #[test]
    #[ignore = "requires a configured local Codex installation"]
    fn reads_local_codex_config() {
        let result = codex_native_config();
        assert_eq!(result["status"], "read", "无法读取本机 Codex 配置");
        assert!(result["providerName"].as_str().is_some_and(|value| !value.is_empty()));
        assert!(result["model"].as_str().is_some_and(|value| !value.is_empty()));
        assert!(result["baseUrl"].as_str().is_some_and(|value| !value.is_empty()));
    }
}

pub fn list(host: &Host, harness: &str) -> Result<Value, String> {
    let settings = read(host, harness)?;
    let items = settings.items.iter().map(|p| Ok(json!({"id":p.id,"name":p.name,"baseUrl":p.base_url,"model":p.model,"models":p.models,"hasKey":secrets::get(&p.id)?.is_some()}))).collect::<Result<Vec<_>, String>>()?;
    let native = (harness == "acp:codex").then(|| {
        let mut config = codex_native_config();
        if let Some(id) = config["providerId"].as_str() {
            let models = settings.native_models.get(id).cloned().unwrap_or_default();
            config["models"] = json!(models);
        }
        config
    });
    let can_import = harness == "acp:codex" && !settings.legacy_imported
        && codex_config_path().is_ok_and(|p| p.with_file_name("codev.json").is_file());
    let active = if settings.active == CODEX_OFFICIAL { CODEX_OFFICIAL } else { &settings.active };
    Ok(json!({"active": active, "items": items, "native": native, "canImport":can_import}))
}

pub fn catalog_action(host: &Host, harness: &str, id: &str, action: &str) -> Result<Value, String> {
    match action {
        "harness.providers.import" if harness == "acp:codex" => catalog::import_legacy(host),
        "harness.providers.duplicate" => catalog::duplicate(host, harness, id),
        "harness.providers.discover" => catalog::discover(host, harness, id),
        _ => Err("不支持此资源操作".into()),
    }
}

fn model_catalog(payload: &Value, default_model: &str) -> Vec<String> {
    let mut models = Vec::new();
    for name in std::iter::once(default_model).chain(payload["models"].as_array().into_iter().flatten().filter_map(Value::as_str)) {
        let name = name.trim();
        if !name.is_empty() && !models.iter().any(|v| v == name) { models.push(name.to_owned()); }
    }
    models
}

pub fn save(host: &Host, harness: &str, payload: &Value) -> Result<Value, String> {
    let mut settings = read(host, harness)?;
    let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    let id = if id.is_empty() { new_id() } else if settings.items.iter().any(|p| p.id == id) { id.to_string() } else { return Err("供应商不存在".into()) };
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let model = field("model");
    let item = Provider { id: id.clone(), name: field("name"), base_url: field("baseUrl"), models: model_catalog(payload, &model), model };
    if item.name.is_empty() || item.model.is_empty() { return Err("请输入供应商名称和模型".into()); }
    validate_base_url(&item.base_url)?;
    let key = payload.get("apiKey").and_then(Value::as_str).unwrap_or("").trim();
    if key.contains(['\r', '\n']) { return Err("密钥不能包含换行".into()); }
    if key.is_empty() && secrets::get(&id)?.is_none() { return Err("请输入 API Key".into()); }
    let old_key = if key.is_empty() { None } else { secrets::get(&id)? };
    if !key.is_empty() { secrets::set(&id, key)?; }
    if let Some(old) = settings.items.iter_mut().find(|p| p.id == id) { *old = item; } else { settings.items.push(item); }
    if let Err(error) = write(host, harness, &settings) {
        if !key.is_empty() {
            let restored = match old_key { Some(value) => secrets::set(&id, &value), None => secrets::delete(&id) };
            if restored.is_err() { return Err(format!("保存失败：{error}；恢复原凭据失败，请重新填写密钥")); }
        }
        return Err(error);
    }
    let result = list(host, harness);
    if harness == "acp:antigravity" {
        refresh_agy_session_models(host);
    }
    result
}

pub fn remove(host: &Host, harness: &str, id: &str) -> Result<Value, String> {
    let mut settings = read(host, harness)?;
    if !settings.items.iter().any(|p| p.id == id) { return Err("资源不存在".into()); }
    if settings.active == id { return Err("请先切换到其他供应商".into()); }
    let session_ids: std::collections::HashSet<_> = lock(&host.state).sessions.keys().cloned().collect();
    if harness == "acp:antigravity" && lock(&host.store).preference("agySessionProviders").and_then(|v| v.as_object().cloned()).is_some_and(|m| m.iter().any(|(session, v)| session_ids.contains(session) && v.as_str() == Some(id))) {
        return Err("此供应商仍有绑定的 Antigravity 线程，请保留配置以便恢复会话".into());
    }
    settings.items.retain(|p| p.id != id);
    write(host, harness, &settings)?;
    secrets::delete(id)?;
    list(host, harness)
}

pub fn selected(host: &Host, harness: &str) -> Result<Option<Provider>, String> {
    let settings = read(host, harness)?;
    if settings.active.is_empty() || (harness == "acp:codex" && settings.active == CODEX_OFFICIAL) { return Ok(None); }
    settings.items.into_iter().find(|p| p.id == settings.active).map(Some).ok_or("当前供应商不存在".into())
}

pub(super) fn codex_official_selected(host: &Host) -> Result<bool, String> {
    Ok(read(host, "acp:codex")?.active == CODEX_OFFICIAL)
}

pub fn normalize_agy_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let without_version = if trimmed.len() >= 7 && trimmed[trimmed.len() - 7..].eq_ignore_ascii_case("/v1beta") {
        &trimmed[..trimmed.len() - 7]
    } else {
        trimmed
    };
    without_version.trim_end_matches('/').to_string()
}

pub fn acp_session_provider(
    host: &Host,
    session_id: &str,
    harness: &str,
    native: bool,
    desktop: bool,
) -> Result<Option<Provider>, String> {
    match harness {
        "acp:codex" => selected(host, harness),
        "acp:antigravity" => agy_for_session(host, session_id, native, desktop),
        _ => Ok(None),
    }
}

pub fn acp_provider_scope(
    host: &Host,
    session_id: &str,
    harness: &str,
    native: bool,
    desktop: bool,
) -> (String, Option<Vec<String>>) {
    match acp_session_provider(host, session_id, harness, native, desktop) {
        Ok(Some(provider)) => {
            let models = (harness == "acp:antigravity" && !provider.models.is_empty()).then_some(provider.models);
            (provider.name, models)
        }
        _ => {
            let label = match harness {
                "acp:antigravity" => if desktop { "Antigravity 桌面端" } else { "Google 官方登录" },
                "acp:codex" if codex_official_selected(host).unwrap_or(false) => "OpenAI Official",
                _ => harness,
            };
            (label.to_string(), None)
        }
    }
}

pub fn agy_for_session(host: &Host, session_id: &str, _native: bool, _desktop: bool) -> Result<Option<Provider>, String> {
    let bindings = lock(&host.store).preference("agySessionProviders").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let selected = selected(host, "acp:antigravity")?;
    let id = match bindings.get(session_id).and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => selected.as_ref().map(|p| p.id.clone()).unwrap_or_default(),
    };
    if id.is_empty() { return Ok(None); }
    read(host, "acp:antigravity")?.items.into_iter().find(|p| p.id == id).map(Some).ok_or("会话绑定的 Antigravity 供应商不存在".into())
}

fn is_dir_link(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return (meta.file_attributes() & 0x400) != 0;
    }
    #[cfg(not(windows))]
    false
}

fn merge_dir_into(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let Ok(entries) = std::fs::read_dir(src) else { return Ok(()) };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            merge_dir_into(&from, &to)?;
            let _ = std::fs::remove_dir(&from);
        } else if !to.exists() {
            if std::fs::rename(&from, &to).is_err() {
                std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
                std::fs::remove_file(&from).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn ensure_dir_link(shared: &std::path::Path, link: &std::path::Path, err_msg: &str) -> Result<(), String> {
    if is_dir_link(link) {
        return Ok(());
    }
    if link.is_dir() {
        merge_dir_into(link, shared)?;
        std::fs::remove_dir_all(link).map_err(|e| e.to_string())?;
    } else if std::fs::symlink_metadata(link).is_ok() {
        return Err("目标路径已存在同名文件，无法创建 Antigravity 共享目录联接".into());
    }
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(shared, link).is_err() {
        use std::os::windows::process::CommandExt;
        let link_arg = link.to_string_lossy();
        let shared_arg = shared.to_string_lossy();
        if link_arg.contains(['%', '!', '"', '\r', '\n']) || shared_arg.contains(['%', '!', '"', '\r', '\n']) {
            return Err("共享目录路径包含无法用于目录联接的字符".into());
        }
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/V:OFF", "/S", "/C"]).raw_arg(format!("\"mklink /J \"{link_arg}\" \"{shared_arg}\"\""));
        crate::modules::proc::hide_console(&mut command);
        let status = command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(|e| e.to_string())?;
        if !status.success() { return Err(err_msg.into()); }
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(shared, link).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn agy_launch(host: &Host, provider: &Provider, desktop: bool) -> Result<(Vec<String>, Vec<(&'static str, Option<String>)>), String> {
    let dir: PathBuf = host.directory.join("agent-providers").join("agy").join(&provider.id);
    let app_subdir = if desktop { "antigravity" } else { "antigravity-cli" };
    let settings = dir.join(app_subdir).join("settings.json");
    std::fs::create_dir_all(settings.parent().ok_or("供应商目录无效")?).map_err(|e| e.to_string())?;
    let mut config = match std::fs::read(&settings) { Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?, Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}), Err(e) => return Err(e.to_string()) };
    let object = config.as_object_mut().ok_or("Antigravity 配置格式错误")?;
    object.insert("modelProvider".into(), json!("gemini"));
    object.insert("model".into(), json!(provider.model));
    let mut file = tempfile::NamedTempFile::new_in(settings.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, &config).map_err(|e| e.to_string())?;
    file.persist(&settings).map_err(|e| e.error.to_string())?;
    let gemini_home = dirs::home_dir().ok_or("无法定位用户目录")?.join(".gemini");
    let shared_config = gemini_home.join("config");
    std::fs::create_dir_all(&shared_config).map_err(|e| e.to_string())?;
    ensure_dir_link(&shared_config, &dir.join("config"), "无法连接 Antigravity 共享技能目录")?;
    let native_app = gemini_home.join(app_subdir);
    let target_app = dir.join(app_subdir);
    for subdir in ["conversations", "brain", "annotations", "implicit"] {
        let shared_sub = native_app.join(subdir);
        if !desktop {
            std::fs::create_dir_all(&shared_sub).map_err(|e| e.to_string())?;
        }
        if shared_sub.is_dir() {
            ensure_dir_link(&shared_sub, &target_app.join(subdir), "无法连接 Antigravity 原生会话历史目录")?;
        }
    }
    let key = secrets::get(&provider.id)?.ok_or("供应商密钥不存在")?;
    Ok((
        vec!["--gemini-dir".into(), dir.to_string_lossy().into_owned()],
        vec![
            ("GEMINI_API_KEY", Some(key)),
            ("GOOGLE_GEMINI_BASE_URL", Some(normalize_agy_base_url(&provider.base_url))),
        ],
    ))
}

pub async fn apply_codex(runtime: &Arc<Runtime>, provider: Option<&Provider>) -> Result<(), String> {
    match provider {
        Some(provider) => {
            let key = secrets::get(&provider.id)?.ok_or("供应商密钥不存在")?;
            runtime.bridge.protect_secret(&key);
            runtime.bridge.request("providers/set", json!({"providerId":"openai","providerName":provider.name,"apiType":"openai","baseUrl":provider.base_url,"headers":{"Authorization":format!("Bearer {key}")}}), Duration::from_secs(120)).await.map_err(|error| error.replace(&key, "[已隐藏]"))?;
        }
        None => { runtime.bridge.request("providers/disable", json!({"providerId":"openai"}), Duration::from_secs(120)).await?; }
    }
    Ok(())
}

pub async fn prepare_reconnect(host: &Host, harness: &str, provider_id: &str) -> Result<Vec<String>, String> {
    let settings = read(host, harness)?;
    if harness == "acp:codex" && settings.active != provider_id { return Err("请先切换到此供应商，再应用到线程".into()); }
    if harness == "acp:antigravity" && !provider_id.is_empty() && !settings.items.iter().any(|p| p.id == provider_id) { return Err("供应商不存在".into()); }
    let bindings = lock(&host.store).preference("agySessionProviders").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let runtimes: Vec<_> = {
        let state = lock(&host.state);
        lock(&host.runtimes).iter().filter(|(id, _)| {
            state.sessions.get(*id).is_some_and(|v| v.binding.harness_id == harness &&
                (harness == "acp:codex" || bindings.get(*id).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(settings.active.as_str()) == provider_id))
        }).map(|(id, runtime)| (id.clone(), runtime.clone())).collect()
    };
    let mut guards = Vec::new();
    for (_, runtime) in &runtimes { guards.push(runtime.gate.try_lock().map_err(|_| "线程正在应用配置，请稍后重试")?); }
    if runtimes.iter().any(|(id, _)| host.view(id).map(|v| v.busy() || !v.queue.is_empty()).unwrap_or(true)) { return Err("相关线程正在运行，请等待任务结束后应用".into()); }
    for (id, _) in &runtimes { host.stop_runtime(id)?; }
    Ok(runtimes.iter().map(|(id, _)| id.clone()).collect())
}

async fn set_codex_model(host: &Host, id: &str, runtime: &Arc<Runtime>, model: &str) -> Result<(), String> {
    let view = host.view(id)?;
    let config_id = view.config_options.iter().find(|v| v.get("category").and_then(Value::as_str) == Some("model") || v.get("id").and_then(Value::as_str) == Some("model")).and_then(|v| v.get("id")).and_then(Value::as_str).unwrap_or("");
    if config_id.is_empty() {
        let native = lock(&runtime.native_id).clone();
        runtime.bridge.request("session/set_model", json!({"sessionId":native,"modelId":model}), Duration::from_secs(120)).await?;
        host.update(id, Some(&runtime.instance), |v| v.model = v.models.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(model)).cloned());
    } else {
        host.set_acp_config(id, runtime, config_id, model).await?;
    }
    Ok(())
}

pub async fn activate(host: &Arc<Host>, harness: &str, id: &str) -> Result<Value, String> {
    let mut settings = read(host, harness)?;
    let next = if id.is_empty() { None } else { Some(settings.items.iter().find(|p| p.id == id).cloned().ok_or("供应商不存在")?) };
    if let Some(ref provider) = next { secrets::get(&provider.id)?.ok_or("供应商密钥不存在")?; }
    let previous = settings.items.iter().find(|p| p.id == settings.active).cloned();
    if harness == "acp:codex" {
        let runtimes: Vec<_> = { let state = lock(&host.state); lock(&host.runtimes).iter().filter(|(id, _)| state.sessions.get(*id).is_some_and(|v| v.binding.harness_id == harness)).map(|(id, r)| (id.clone(), r.clone())).collect() };
        let mut guards = Vec::new();
        for (_, runtime) in &runtimes { guards.push(runtime.gate.try_lock().map_err(|_| "会话正在应用配置，请稍后切换")?); }
        if runtimes.iter().any(|(id, _)| host.view(id).map(|v| v.busy() || !v.queue.is_empty()).unwrap_or(true)) { return Err("Codex 有运行中的会话，请等待完成后切换".into()); }
        let mut applied: Vec<(String, Arc<Runtime>, Option<String>)> = Vec::new();
        for (id, runtime) in &runtimes {
            let old_model = host.view(id)?.model.as_ref().and_then(|v| v.get("id")).and_then(Value::as_str).map(str::to_string);
            let change = async {
                apply_codex(runtime, next.as_ref()).await?;
                if let Some(provider) = &next {
                    set_codex_model(host, id, runtime, &provider.model).await?;
                }
                Ok::<(), String>(())
            }.await;
            if let Err(error) = change {
                let mut rollback_failed = false;
                applied.push((id.clone(), runtime.clone(), old_model));
                for (session, done, model) in &applied {
                    if apply_codex(done, previous.as_ref()).await.is_err() || match model { Some(model) => set_codex_model(host, session, done, model).await.is_err(), None => false } {
                        rollback_failed = true;
                        let _ = host.stop_runtime(session);
                    }
                }
                return Err(if rollback_failed { format!("切换失败：{error}；部分会话回滚失败，请重新连接") } else { format!("切换失败，已恢复原供应商：{error}") });
            }
            applied.push((id.clone(), runtime.clone(), old_model));
        }
        settings.active = id.into();
        if let Err(error) = write(host, harness, &settings) {
            for (session, runtime, model) in &applied {
                if apply_codex(runtime, previous.as_ref()).await.is_err() || match model { Some(model) => set_codex_model(host, session, runtime, model).await.is_err(), None => false } { let _ = host.stop_runtime(session); }
            }
            return Err(format!("保存供应商选择失败：{error}"));
        }
        drop(guards);
        return list(host, harness);
    }
    settings.active = id.into();
    write(host, harness, &settings)?;
    let result = list(host, harness);
    if harness == "acp:antigravity" {
        refresh_agy_session_models(host);
    }
    result
}

#[cfg(test)]
pub(super) fn refresh_agy_session_models_for_test(host: &Host) {
    refresh_agy_session_models(host);
}

fn refresh_agy_session_models(host: &Host) {
    let ids: Vec<String> = {
        let state = lock(&host.state);
        state
            .sessions
            .iter()
            .filter(|(_, v)| {
                v.binding.harness_id == "acp:antigravity"
                    && (!v.config_options.is_empty() || !v.models.is_empty())
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for sid in ids {
        let Ok(view) = host.view(&sid) else { continue };
        let desktop = super::antigravity_history::is_desktop(&view.binding);
        let native = view.binding.native_session_id.is_some();
        let (label, allowed) = acp_provider_scope(host, &sid, "acp:antigravity", native, desktop);
        host.update(&sid, None, |v| {
            super::acp::refresh_view_provider_scope(v, &label, allowed.as_deref());
        });
    }
}
