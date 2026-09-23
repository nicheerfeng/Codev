use serde::Serialize;

const CODEV_LATEST: &str = "https://api.github.com/repos/nicheerfeng/Codev/releases/latest";
const PI_LATEST: &str = "https://api.github.com/repos/earendil-works/pi/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRelease {
    latest: Option<String>,
    name: Option<String>,
    published_at: Option<String>,
    notes: Option<String>,
    release_url: Option<String>,
}

fn release_url_for(channel: &str) -> Result<&'static str, String> {
    match channel {
        "codev" => Ok(CODEV_LATEST),
        "pi" => Ok(PI_LATEST),
        _ => Err("未知的发行频道".to_string()),
    }
}

/// 用本机 HTTP 拉 GitHub latest，避免 WebView 缺 User-Agent 被 403。
#[tauri::command]
pub async fn github_latest_release(channel: String) -> Result<GithubRelease, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_release(&channel))
        .await.map_err(|error| error.to_string())?
}

/// 阻塞 HTTP 请求在后台工作线程执行，避免检查更新占用界面线程。
fn fetch_release(channel: &str) -> Result<GithubRelease, String> {
    let url = release_url_for(channel.trim())?;
    let response = ureq::get(url)
        .set("User-Agent", "Codev")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12))
        .call()
        .map_err(|error| format!("GitHub 请求失败：{error}"))?;
    if response.status() >= 400 {
        return Err(format!("GitHub 返回 {}", response.status()));
    }
    let payload: serde_json::Value = response
        .into_json()
        .map_err(|error| format!("GitHub 响应无法解析：{error}"))?;
    Ok(GithubRelease {
        latest: payload
            .get("tag_name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        name: payload
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        published_at: payload
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        notes: payload
            .get("body")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        release_url: payload
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::release_url_for;

    #[test]
    fn allows_only_codev_and_pi_channels() {
        assert!(release_url_for("codev")
            .unwrap()
            .contains("nicheerfeng/Codev"));
        assert!(release_url_for("pi").unwrap().contains("earendil-works/pi"));
        assert!(release_url_for("other").is_err());
    }
}
