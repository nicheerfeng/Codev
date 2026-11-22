//! Standalone agent host. Shares all lifecycle, protocol and storage code with desktop.
#![cfg_attr(not(debug_assertions), windows_subsystem = "console")]
#[tokio::main]
async fn main() {
    if let Err(error) = codev_lib::modules::agent_host::server::run_standalone().await {
        eprintln!("Codev Agent Host: {error}");
        std::process::exit(1);
    }
}
