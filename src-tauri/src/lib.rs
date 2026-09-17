pub mod modules;

use modules::{fs, github, history, pi_agent, pty, workspace};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::PhysicalPosition;
#[cfg(target_os = "windows")]
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler,
};
#[cfg(target_os = "windows")]
use windows::core::{Interface, PWSTR};

const HTML_PREVIEW_BRIDGE: &str = include_str!("html_preview_bridge.js");

/// 应用内 WebView 允许继续加载的地址，其余 http(s) 交给系统浏览器。
fn is_app_webview_url(uri: &str) -> bool {
    let lower = uri.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    const APP_PREFIXES: &[&str] = &[
        "https://tauri.localhost",
        "http://tauri.localhost",
        "tauri://",
        "https://asset.localhost",
        "http://asset.localhost",
        "asset://",
        "https://ipc.localhost",
        "http://ipc.localhost",
        "ipc://",
        "about:",
        "data:",
        "blob:",
        "file:",
    ];
    if APP_PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    lower.starts_with("http://localhost")
        || lower.starts_with("https://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("https://127.0.0.1")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://[::1]")
}

fn is_external_browser_url(uri: &str) -> bool {
    let lower = uri.trim().to_ascii_lowercase();
    (lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:"))
        && !is_app_webview_url(uri)
}

fn open_external_browser(uri: &str) {
    if let Err(error) = tauri_plugin_opener::open_url(uri, None::<&str>) {
        log::warn!("[Codev] failed to open external url {uri}: {error}");
    }
}

/// 关闭 WebView2 原生菜单与浏览器快捷键，覆盖阅读器和所有 iframe。
#[cfg(target_os = "windows")]
fn disable_browser_accelerator_keys(
    window: &tauri::WebviewWindow<tauri::Wry>,
) -> Result<(), String> {
    window
        .with_webview(|webview| {
            let result = (|| -> Result<(), String> {
                let core_webview = unsafe {
                    webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?
                };
                let settings = unsafe {
                    core_webview
                        .Settings()
                        .map_err(|error| error.to_string())?
                };
                unsafe {
                    settings
                        .SetAreDefaultContextMenusEnabled(false)
                        .map_err(|error| error.to_string())?
                };
                let settings3 = settings
                    .cast::<ICoreWebView2Settings3>()
                    .map_err(|error| error.to_string())?;
                unsafe {
                    settings3
                        .SetAreBrowserAcceleratorKeysEnabled(false)
                        .map_err(|error| error.to_string())?
                };
                Ok(())
            })();
            if let Err(error) = result {
                log::warn!("[Codev] browser accelerator keys unchanged: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

/// 拦住 PDF/iframe 把顶层 WebView 导航成外部网页，改为系统浏览器打开。
#[cfg(target_os = "windows")]
fn guard_webview_navigation(window: &tauri::WebviewWindow<tauri::Wry>) -> Result<(), String> {
    window
        .with_webview(|webview| {
            let result = (|| -> Result<(), String> {
                let core_webview = unsafe {
                    webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?
                };
                let mut token = 0_i64;
                unsafe {
                    core_webview
                        .add_NavigationStarting(
                            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                                let Some(args) = args else {
                                    return Ok(());
                                };
                                let uri = {
                                    let mut uri = PWSTR::null();
                                    args.Uri(&mut uri)?;
                                    take_pwstr(uri)
                                };
                                if is_external_browser_url(&uri) {
                                    args.SetCancel(true)?;
                                    open_external_browser(&uri);
                                }
                                Ok(())
                            })),
                            &mut token,
                        )
                        .map_err(|error| error.to_string())?;
                    core_webview
                        .add_NewWindowRequested(
                            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                                let Some(args) = args else {
                                    return Ok(());
                                };
                                let uri = {
                                    let mut uri = PWSTR::null();
                                    args.Uri(&mut uri)?;
                                    take_pwstr(uri)
                                };
                                if is_external_browser_url(&uri) {
                                    args.SetHandled(true)?;
                                    open_external_browser(&uri);
                                }
                                Ok(())
                            })),
                            &mut token,
                        )
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                log::warn!("[Codev] webview navigation guard unchanged: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Drained on first read so HMR / re-mounts can't replay the launch files.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTargetPayload {
    dir: Option<String>,
    files: Vec<String>,
}

#[derive(Default)]
struct PendingOpenTargets(Mutex<Vec<OpenTargetPayload>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
}

/// 取出单实例转发期间暂存的外部打开请求。
#[tauri::command]
fn get_pending_open_targets(state: State<'_, PendingOpenTargets>) -> Vec<OpenTargetPayload> {
    std::mem::take(&mut *state.0.lock().expect("PendingOpenTargets mutex poisoned"))
}

enum LaunchEntry {
    Dir(PathBuf),
    File(PathBuf),
}

#[derive(Default, Debug, PartialEq)]
struct LaunchTarget {
    dir: Option<String>,
    files: Vec<String>,
}

/// First dir arg (else the first file's parent) becomes the workspace; every
/// file arg is opened. Kept free of fs/env access so it stays unit-testable.
fn resolve_launch_target(entries: Vec<LaunchEntry>) -> LaunchTarget {
    let mut dir = None;
    let mut files = Vec::new();
    for entry in entries {
        match entry {
            LaunchEntry::Dir(path) => {
                if dir.is_none() {
                    dir = Some(fs::to_canon(&path));
                }
            }
            LaunchEntry::File(path) => {
                if dir.is_none() {
                    dir = path.parent().map(fs::to_canon);
                }
                files.push(fs::to_canon(&path));
            }
        }
    }
    LaunchTarget { dir, files }
}

/// 将一组外部启动参数解析为目录和文件目标。
fn parse_launch_target_args<I>(args: I) -> LaunchTarget
where
    I: IntoIterator<Item = String>,
{
    let entries = args
        .into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| std::fs::canonicalize(arg).ok())
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(if meta.is_dir() {
                LaunchEntry::Dir(path)
            } else {
                LaunchEntry::File(path)
            })
        })
        .collect();
    resolve_launch_target(entries)
}

/// 解析当前进程首次启动时收到的外部路径。
fn parse_launch_target() -> LaunchTarget {
    parse_launch_target_args(std::env::args().skip(1))
}

/// 将外部打开请求交给已有主窗口，避免资源管理器重复创建实例。
fn queue_open_target(app: &tauri::AppHandle, target: LaunchTarget) {
    if target.dir.is_none() && target.files.is_empty() {
        return;
    }
    let payload = OpenTargetPayload {
        dir: target.dir,
        files: target.files,
    };
    if let Some(state) = app.try_state::<PendingOpenTargets>() {
        state
            .0
            .lock()
            .expect("PendingOpenTargets mutex poisoned")
            .push(payload);
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit("codev:open-target", ());
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn quit_app(app: &tauri::AppHandle) {
    let _ = pi_agent::pi_agent_close_all(app.state());
    app.exit(0);
}

/// 托盘「退出」走这条路径，先停 Pi 再结束进程。
#[tauri::command]
fn codev_quit(app: tauri::AppHandle) {
    quit_app(&app);
}

fn install_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示主窗口")
        .text("quit", "退出")
        .build()?;
    let mut builder = TrayIconBuilder::with_id("codev-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Codev")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 打开并居中单页面设置窗口。
#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    let url_path = "settings.html".to_string();

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.center();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(760.0, 620.0)
        .min_inner_size(680.0, 500.0)
        .resizable(true)
        .visible(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    // macOS: skip parent() — child + always_on_top leaves the settings webview
    // behind the main window except while the parent is being dragged (#33).
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(main) = app.get_webview_window("main") {
        builder.parent(&main).map_err(|e| e.to_string())?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // Linux keeps the transparent custom chrome; Windows stays opaque so the
    // installed and portable builds use the same low-composition path.
    #[cfg(target_os = "linux")]
    let builder = builder.decorations(false).transparent(true);

    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.center();

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = parse_launch_target();
    let cli_dir = launch.dir.clone();
    workspace::init_launch_cwd(cli_dir.as_deref());

    let builder = tauri::Builder::default().plugin(
        tauri::plugin::Builder::<tauri::Wry, ()>::new("html-preview")
            .js_init_script_on_all_frames(HTML_PREVIEW_BRIDGE)
            .build(),
    );
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let target = parse_launch_target_args(argv.into_iter().skip(1));
        queue_open_target(app, target);
    }));
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |_app| {
            if let Err(error) = install_tray(_app.handle()) {
                log::warn!("[Codev] tray icon unavailable: {error}");
            }
            if let Some(main) = _app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                let _ = disable_browser_accelerator_keys(&main);
                #[cfg(target_os = "windows")]
                let _ = guard_webview_navigation(&main);
            }
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(fs::transfer::TransferState::default())
        .manage(history::HistoryState::default())
        .manage(pi_agent::PiAgentState::default())
        .manage(fs::grep::ContentSearchState::default())
        .manage(PendingOpenTargets::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchFiles(Mutex::new(launch.files)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pty::pty_has_foreground_job,
            pty::pty_shell_name,
            pty::pty_list_shells,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::clipboard::fs_get_file_clipboard,
            fs::file::fs_read_file,
            fs::file::fs_read_asset_bytes,
            fs::file::fs_read_text_window,
            fs::file::fs_index_text_lines,
            fs::file::fs_read_text_lines,
            fs::file::fs_read_text_line_previews,
            fs::file::fs_read_full_text_lines,
            fs::file::fs_find_text,
            fs::file::fs_replace_text,
            fs::file::fs_allow_asset,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::mutate::fs_copy,
            fs::transfer::fs_transfer_execute,
            fs::transfer::fs_transfer_cancel,
            fs::transfer::fs_transfer_undo,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_grep_interactive,
            fs::grep::fs_glob,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            get_launch_files,
            get_pending_open_targets,
            open_settings_window,
            history::history_suggest,
            history::history_commands,
            history::history_record,
            history::history_list,
            pi_agent::pi_agent_probe,
            pi_agent::pi_agent_list_sessions,
            pi_agent::pi_agent_list_all_sessions,
            pi_agent::pi_agent_delete_session,
            pi_agent::pi_agent_read_models,
            pi_agent::pi_agent_write_models,
            pi_agent::pi_agent_read_session,
            pi_agent::pi_agent_clone_session,
            pi_agent::pi_agent_append_session,
            pi_agent::pi_agent_list_models,
            pi_agent::pi_agent_start,
            pi_agent::pi_agent_send,
            pi_agent::pi_agent_close,
            pi_agent::pi_agent_close_all,
            pi_agent::pi_agent_watch_sessions,
            pi_agent::pi_agent_list_assets,
            pi_agent::pi_agent_list_package_specs,
            pi_agent::pi_agent_install_package,
            pi_agent::pi_agent_home_dir,
            pi_agent::codev_install_stamp,
            github::github_latest_release,
            codev_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            match event {
                // macOS delivers "Open With" files here, not as argv (cold and
                // warm start, several at once). Seed the drain-once state and
                // emit; canonicalize so the /tmp -> /private/tmp symlink can't
                // defeat openFileTab's path dedupe against a CLI launch.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let entries = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .filter_map(|p| std::fs::canonicalize(p).ok())
                        .filter_map(|p| {
                            if p.is_dir() {
                                Some(LaunchEntry::Dir(p))
                            } else if p.is_file() {
                                Some(LaunchEntry::File(p))
                            } else {
                                None
                            }
                        })
                        .collect();
                    let target = resolve_launch_target(entries);
                    queue_open_target(_app, target);
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod launch_target_tests {
    use super::{
        is_app_webview_url, is_external_browser_url, resolve_launch_target, LaunchEntry,
        LaunchTarget,
    };
    use std::path::PathBuf;

    #[test]
    fn keeps_codev_and_asset_urls_inside_the_app() {
        for uri in [
            "https://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/src/main.tsx",
            "https://asset.localhost/D:/a.pdf",
            "http://asset.localhost/C:/tmp/file.pdf",
            "asset://localhost/D:/a.pdf",
            "about:blank",
            "data:application/pdf,test",
        ] {
            assert!(is_app_webview_url(uri), "{uri}");
            assert!(!is_external_browser_url(uri), "{uri}");
        }
    }

    #[test]
    fn sends_pdf_reference_links_to_the_system_browser() {
        for uri in [
            "https://pubmed.ncbi.nlm.nih.gov/123/",
            "http://www.example.com/paper",
            "mailto:a@b.com",
        ] {
            assert!(!is_app_webview_url(uri), "{uri}");
            assert!(is_external_browser_url(uri), "{uri}");
        }
    }

    #[test]
    fn leaves_edge_pdf_viewer_internal_pages_alone() {
        for uri in [
            "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
            "edge://pdf/viewer",
            "pdf.js",
        ] {
            assert!(!is_external_browser_url(uri), "{uri}");
        }
    }

    #[test]
    fn no_entries_resolves_to_empty() {
        assert_eq!(resolve_launch_target(vec![]), LaunchTarget::default());
    }

    #[test]
    fn dir_arg_sets_workspace_and_opens_nothing() {
        let out = resolve_launch_target(vec![LaunchEntry::Dir(PathBuf::from("/home/u/proj"))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert!(out.files.is_empty());
    }

    #[test]
    fn file_arg_opens_file_and_uses_parent_as_workspace() {
        let out =
            resolve_launch_target(vec![LaunchEntry::File(PathBuf::from("/home/u/proj/main.rs"))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert_eq!(out.files, vec!["/home/u/proj/main.rs".to_string()]);
    }

    #[test]
    fn multiple_files_all_open_and_first_parent_wins() {
        let out = resolve_launch_target(vec![
            LaunchEntry::File(PathBuf::from("/a/one.txt")),
            LaunchEntry::File(PathBuf::from("/b/two.txt")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/a"));
        assert_eq!(
            out.files,
            vec!["/a/one.txt".to_string(), "/b/two.txt".to_string()]
        );
    }

    #[test]
    fn explicit_dir_takes_precedence_over_file_parent() {
        let out = resolve_launch_target(vec![
            LaunchEntry::Dir(PathBuf::from("/workspace")),
            LaunchEntry::File(PathBuf::from("/other/x.rs")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/workspace"));
        assert_eq!(out.files, vec!["/other/x.rs".to_string()]);
    }
}
