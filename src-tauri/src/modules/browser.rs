use serde::Deserialize;
use tauri::webview::WebviewBuilder;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

fn browser_label(id: Option<&str>) -> Result<String, String> {
    let id = id.unwrap_or("default");
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("无效的浏览器视口标识".into());
    }
    Ok(format!("plugin-browser-{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_labels_are_scoped_and_reject_invalid_ids() {
        assert_eq!(browser_label(None).unwrap(), "plugin-browser-default");
        assert_ne!(browser_label(Some("page-1")).unwrap(), browser_label(Some("page-2")).unwrap());
        for id in ["", "../main", "main/settings", "page:1"] {
            assert!(browser_label(Some(id)).is_err());
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn parse_url(url: &str) -> Result<Url, String> {
    let text = url.trim();
    if text.is_empty() {
        return Err("请输入网址".into());
    }
    Url::parse(text)
        .or_else(|_| Url::parse(&format!("https://{text}")))
        .map_err(|error| error.to_string())
}

fn apply_bounds(
    webview: &tauri::Webview<tauri::Wry>,
    bounds: BrowserBounds,
) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_show(
    app: tauri::AppHandle,
    url: String,
    bounds: BrowserBounds,
    id: Option<String>,
    navigate: Option<bool>,
) -> Result<(), String> {
    let label = browser_label(id.as_deref())?;
    let parsed = parse_url(&url)?;
    if let Some(webview) = app.get_webview(&label) {
        let current = webview.url().ok().map(|url| url.to_string()).unwrap_or_default();
        if navigate.unwrap_or(true) && current.trim_end_matches('/') != parsed.to_string().trim_end_matches('/') {
            webview.navigate(parsed).map_err(|error| error.to_string())?;
        }
        apply_bounds(&webview, bounds)?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("没有主窗口")?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed)).incognito(true);
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);
    let builder = builder.on_document_title_changed(move |webview, title| {
            let _ = webview.emit("codev://browser-title", serde_json::json!({"id": id.as_deref().unwrap_or("default"), "title": title}));
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    webview.set_auto_resize(false).map_err(|error| error.to_string())?;
    webview.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: tauri::AppHandle,
    bounds: BrowserBounds,
    id: Option<String>,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&browser_label(id.as_deref())?) else {
        return Ok(());
    };
    apply_bounds(&webview, bounds)
}

#[tauri::command]
pub async fn browser_reload(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    app.get_webview(&browser_label(id.as_deref())?)
        .ok_or("浏览器未打开")?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_inspect(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let webview = app.get_webview(&browser_label(id.as_deref())?).ok_or("浏览器未打开")?;
    #[cfg(debug_assertions)]
    {
        webview.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = webview;
        Err("当前安装包不包含网页检查工具".into())
    }
}

#[tauri::command]
pub async fn browser_hide(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(id.as_deref())?) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_close(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(id.as_deref())?) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

