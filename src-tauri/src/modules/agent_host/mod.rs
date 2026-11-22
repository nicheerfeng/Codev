//! Shared Rust agent host: desktop and remote clients use the same service.
mod acp;
mod auth;
mod bridge;
mod commands;
mod coordinator;
mod history;
mod metadata;
mod migration;
mod native_pi;
pub mod protocol;
mod registry;
pub mod server;
#[cfg(test)]
mod tests;

use coordinator::Host;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

pub struct HostService {
    pub host: Arc<Host>,
    pub port: u16,
}
#[derive(Default)]
pub struct AgentHostState {
    service: tokio::sync::OnceCell<HostService>,
}
impl AgentHostState {
    pub fn shutdown(&self) {
        if let Some(service) = self.service.get() {
            service.host.close_all();
        }
    }
}

#[tauri::command]
pub async fn agent_host_bootstrap(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentHostState>,
) -> Result<Value, String> {
    let service = state
        .service
        .get_or_try_init(|| async {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("agent-host");
            let host = Host::open(directory.clone(), server::find_web_directory())?;
            // Import application project/session bindings only; never CLI credentials.
            let legacy = directory.parent().map(|p| p.join("codev-plugins.json"));
            if bridge::lock(&host.store)
                .preference("legacyMetadataImported")
                .is_none()
            {
                if let Some(path) = legacy {
                    if let Ok(content) = tokio::fs::read_to_string(path).await {
                        if let Ok(config) = serde_json::from_str::<Value>(&content) {
                            host.import_legacy_preferences(&config)?;
                        }
                    }
                }
                bridge::lock(&host.store).set_preference("legacyMetadataImported", &json!(true))?;
            }
            host.start_background();
            let port = server::start_local(host.clone()).await?;
            Ok::<_, String>(HostService { host, port })
        })
        .await?;
    Ok(
        json!({"protocolVersion":protocol::PROTOCOL_VERSION,"endpoint":format!("ws://127.0.0.1:{}/v1/ws",service.port),"token":service.host.desktop_token,"serverId":service.host.id}),
    )
}

#[tauri::command]
pub fn codev_install_stamp() -> Option<String> {
    dirs::data_local_dir()
        .map(|path| path.join("Codev/install-stamp"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}
