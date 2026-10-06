use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            if let Some(current) = target.get_mut(key) {
                if current.is_object() && value.is_object() {
                    merge(current, value);
                    continue;
                }
            }
            target.insert(key.clone(), value.clone());
        }
    }
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            Value::Object(entries.into_iter().map(|(key, value)| {
                (key.clone(), canonical(value))
            }).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

/// Hash request configuration without returning credentials or display metadata.
pub(super) fn resource_fingerprint(provider: &Value, model: &Value) -> String {
    let mut request = Value::Object(Map::new());
    for field in ["api", "baseUrl", "apiKey", "oauth", "authHeader", "headers", "compat"] {
        if let Some(value) = provider.get(field) {
            request[field] = value.clone();
        }
    }
    let mut effective = model.clone();
    if let Some(overrides) = model.get("id").and_then(Value::as_str)
        .and_then(|id| provider.get("modelOverrides").and_then(|items| items.get(id)))
    {
        merge(&mut effective, overrides);
    }
    let mut model_request = Value::Object(Map::new());
    for field in [
        "api", "baseUrl", "headers", "compat", "reasoning", "thinkingLevelMap",
        "input", "inputLimits", "maxTokens", "samplingParams", "promptCache",
    ] {
        if let Some(value) = effective.get(field) {
            model_request[field] = value.clone();
        }
    }
    merge(&mut request, &model_request);
    let bytes = canonical(&request).to_string();
    let digest = Sha256::digest(bytes.as_bytes());
    format!("sha256:{digest:x}")
}

#[cfg(test)]
mod tests {
    use super::resource_fingerprint;
    use serde_json::json;

    #[test]
    fn ignores_metadata_sibling_models_and_object_key_order() {
        let provider = json!({"api": "openai-completions", "baseUrl": "https://example.invalid", "apiKey": "test", "headers": {"a": "1", "b": "2"}});
        let model = json!({"id": "a", "maxTokens": 100});
        let mut renamed = model.clone();
        renamed["name"] = json!("Renamed");
        renamed["contextWindow"] = json!(200000);
        renamed["cost"] = json!({"input": 1});
        let mut reordered = provider.clone();
        reordered["headers"] = json!({"b": "2", "a": "1"});
        reordered["models"] = json!([{"id": "unrelated"}]);
        assert_eq!(resource_fingerprint(&provider, &model), resource_fingerprint(&reordered, &renamed));
    }

    #[test]
    fn detects_credentials_protocol_headers_and_effective_model_options() {
        let provider = json!({"baseUrl": "https://example.invalid", "apiKey": "test", "api": "openai-completions"});
        let model = json!({"id": "a"});
        let original = resource_fingerprint(&provider, &model);
        for (field, value) in [
            ("apiKey", json!("changed")),
            ("baseUrl", json!("https://other.invalid")),
            ("api", json!("openai-responses")),
            ("headers", json!({"x-test": "changed"})),
            ("compat", json!({"supportsStore": false})),
            ("modelOverrides", json!({"a": {"maxTokens": 200}})),
        ] {
            let mut changed = provider.clone();
            changed[field] = value;
            assert_ne!(original, resource_fingerprint(&changed, &model), "{field}");
        }
    }

    #[test]
    fn ignores_provider_values_overridden_by_the_selected_model() {
        let mut provider = json!({"baseUrl": "https://first.invalid", "api": "openai-completions"});
        let model = json!({"id": "a", "baseUrl": "https://model.invalid"});
        let original = resource_fingerprint(&provider, &model);
        provider["baseUrl"] = json!("https://second.invalid");
        assert_eq!(original, resource_fingerprint(&provider, &model));
    }
}
