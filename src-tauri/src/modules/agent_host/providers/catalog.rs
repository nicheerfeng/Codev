use super::*;
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyResource {
    alias: String,
    base_url: String,
    key: String,
}

// Stage every credential before publishing the catalog in a single SQLite write.
fn append(host: &Host, harness: &str, mut settings: ProviderSettings, rows: Vec<(Provider, String)>) -> Result<Value, String> {
    let mut staged = Vec::new();
    let result = (|| {
        for (resource, key) in rows {
            if !key.is_empty() {
                secrets::set(&resource.id, &key)?;
                staged.push(resource.id.clone());
            }
            settings.items.push(resource);
        }
        write(host, harness, &settings)
    })();
    if let Err(error) = result {
        for id in staged { secrets::delete(&id)?; }
        return Err(error);
    }
    list(host, harness)
}

pub(super) fn import_legacy(host: &Host) -> Result<Value, String> {
    let mut settings = read(host, "acp:codex")?;
    if settings.legacy_imported { return list(host, "acp:codex"); }
    let path = codex_config_path()?.with_file_name("codev.json");
    let bytes = std::fs::read(path).map_err(|_| "无法读取历史资源库 codev.json")?;
    let legacy: Vec<LegacyResource> = serde_json::from_slice(&bytes).map_err(|_| "历史资源库格式无效")?;
    let mut rows = Vec::new();
    for row in legacy {
        let name = row.alias.trim();
        if name.is_empty() { return Err("历史资源缺少别名".into()); }
        validate_base_url(&row.base_url)?;
        rows.push((Provider { id: new_id(), name: name.into(), base_url: row.base_url, model: String::new(), models: vec![] }, row.key));
    }
    settings.legacy_imported = true;
    append(host, "acp:codex", settings, rows)
}

fn native_connection() -> Result<(Provider, String), String> {
    let source = std::fs::read_to_string(codex_config_path()?).map_err(|_| "无法读取 Codex 原生资源")?;
    let native = parse_codex_native_config(&source);
    let id = native["providerId"].as_str().ok_or("Codex 配置格式无效")?;
    let config: toml::Table = toml::from_str(&source).map_err(|_| "Codex 配置格式无效")?;
    let table = config.get("model_providers").and_then(|p| p.get(id)).ok_or("此资源使用原生账号登录")?;
    let url = table.get("base_url").and_then(toml::Value::as_str).ok_or("此资源未设置 Base URL")?;
    validate_base_url(url)?;
    let key = if let Some(key) = table.get("experimental_bearer_token").and_then(toml::Value::as_str) {
        key.to_owned()
    } else if let Some(var) = table.get("env_key").and_then(toml::Value::as_str) {
        std::env::var(var).map_err(|_| "资源引用的密钥环境变量不可用")?
    } else {
        return Err("此资源使用外部认证，请在 Codex 中验证，或新增独立密钥资源".into());
    };
    let model = native["model"].as_str().unwrap_or_default().to_owned();
    Ok((Provider { id: String::new(), name: native["providerName"].as_str().unwrap_or(id).into(), base_url: url.into(), model, models: vec![] }, key))
}

fn connection(settings: &ProviderSettings, harness: &str, id: &str) -> Result<(Provider, String), String> {
    if id.is_empty() && harness == "acp:codex" {
        let (mut provider, key) = native_connection()?;
        if let Some(native_id) = codex_native_config()["providerId"].as_str() {
            provider.models = settings.native_models.get(native_id).cloned().unwrap_or_default();
        }
        return Ok((provider, key));
    }
    let provider = settings.items.iter().find(|p| p.id == id).ok_or("资源不存在")?.clone();
    let key = secrets::get(id)?.unwrap_or_default();
    Ok((provider, key))
}

pub(super) fn duplicate(host: &Host, harness: &str, id: &str) -> Result<Value, String> {
    let settings = read(host, harness)?;
    let (mut copy, key) = connection(&settings, harness, id)?;
    copy.id = new_id();
    copy.name.push_str(" 副本");
    append(host, harness, settings, vec![(copy, key)])
}

pub(super) fn discover(host: &Host, harness: &str, id: &str) -> Result<Value, String> {
    let (provider, key) = connection(&read(host, harness)?, harness, id)?;
    validate_base_url(&provider.base_url)?;
    let base = provider.base_url.trim_end_matches('/');
    let gemini = harness == "acp:antigravity";
    let url = if gemini && !base.ends_with("/v1beta") && !base.ends_with("/v1") {
        format!("{base}/v1beta/models")
    } else { format!("{base}/models") };
    let client = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).redirects(0).build();
    let mut req = client.get(&url);
    if !key.is_empty() {
        req = if gemini { req.set("x-goog-api-key", &key) } else { req.set("Authorization", &format!("Bearer {key}")) };
    }
    let response = req.call().map_err(|error| match error {
        ureq::Error::Status(code, _) => format!("模型目录返回 HTTP {code}"),
        _ => "无法连接模型目录".into(),
    })?;
    let body: Value = serde_json::from_reader(response.into_reader().take(2 * 1024 * 1024)).map_err(|_| "模型目录不是有效 JSON")?;
    let rows = if gemini {
        body["models"].as_array().or_else(|| body["data"].as_array())
    } else {
        body["data"].as_array()
    }
    .ok_or("供应商未提供标准模型目录")?;
    let models: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            if gemini {
                row["name"]
                    .as_str()
                    .map(|value| value.strip_prefix("models/").unwrap_or(value))
                    .or_else(|| row["id"].as_str())
                    .or_else(|| row["displayName"].as_str())
            } else {
                row["id"].as_str()
            }
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    Ok(json!({"models":models}))
}
