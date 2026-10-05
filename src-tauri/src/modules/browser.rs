use serde::Deserialize;
use tauri::webview::WebviewBuilder;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

const LABEL: &str = "plugin-browser";

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
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    if let Some(webview) = app.get_webview(LABEL) {
        let current = webview.url().ok().map(|url| url.to_string()).unwrap_or_default();
        if current.trim_end_matches('/') != parsed.to_string().trim_end_matches('/') {
            webview.navigate(parsed).map_err(|error| error.to_string())?;
        }
        apply_bounds(&webview, bounds)?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("没有主窗口")?;
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(parsed)).incognito(true);
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);
    let builder = builder.on_document_title_changed(|webview, title| {
            let _ = webview.emit("codev://browser-title", title);
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    webview.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: tauri::AppHandle,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    apply_bounds(&webview, bounds)
}

#[tauri::command]
pub async fn browser_reload(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview(LABEL)
        .ok_or("浏览器未打开")?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_inspect(app: tauri::AppHandle) -> Result<(), String> {
    let webview = app.get_webview(LABEL).ok_or("浏览器未打开")?;
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
pub async fn browser_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(LABEL) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

