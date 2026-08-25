pub mod modules;

use modules::{fs, history, pty, workspace};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, WindowEvent};

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

/// 将旧 Terax 运行时目录中的用户状态迁移到 Codev 命名空间。
fn migrate_legacy_directory(legacy: &Path, current: &Path) -> Result<(), String> {
    if legacy == current || !legacy.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(current).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(legacy).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let name = entry.file_name();
        let target_name = match name.to_str() {
            Some("terax-settings.json") => "codev-settings.json",
            Some("terax-spaces.json") => "codev-spaces.json",
            Some("terax-custom-themes.json") => "codev-custom-themes.json",
            _ => name.to_str().unwrap_or_default(),
        };
        if target_name.is_empty() {
            continue;
        }
        let target = current.join(target_name);
        if target.exists() {
            continue;
        }
        if let Err(error) = std::fs::rename(&source, &target) {
            log::warn!("[Codev] legacy item migration skipped: {error}");
        }
    }

    if std::fs::read_dir(legacy)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        let _ = std::fs::remove_dir(legacy);
    }
    Ok(())
}

/// 将安装升级前的本地缓存和配置目录迁移到新的 Codev 标识符。
fn migrate_legacy_runtime_data(app: &tauri::AppHandle) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    let legacy_config = dirs::config_dir()
        .ok_or_else(|| "legacy config directory unavailable".to_string())?
        .join("app.crynta.terax");
    let legacy_local = dirs::data_local_dir()
        .ok_or_else(|| "legacy local data directory unavailable".to_string())?
        .join("app.crynta.terax");

    migrate_legacy_directory(&legacy_config, &config_dir)?;
    migrate_legacy_directory(&legacy_local, &local_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = parse_launch_target();
    let cli_dir = launch.dir.clone();
    workspace::init_launch_cwd(cli_dir.as_deref());

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let target = parse_launch_target_args(argv.into_iter().skip(1));
        queue_open_target(app, target);
    }));
    #[cfg(target_os = "linux")]
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
        .setup(move |_app| {
            if let Err(error) = migrate_legacy_runtime_data(_app.handle()) {
                log::warn!("[Codev] legacy data migration skipped: {error}");
            }
            // macOS skips parent() for the settings window, so tie its lifecycle
            // to the main window here instead. Other platforms keep parent().
            #[cfg(target_os = "macos")]
            if let Some(main) = _app.get_webview_window("main") {
                let handle = _app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        if let Some(settings) = handle.get_webview_window("settings") {
                            let _ = settings.close();
                        }
                    }
                });
            }
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(fs::transfer::TransferState::default())
        .manage(history::HistoryState::default())
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
    use super::{resolve_launch_target, LaunchEntry, LaunchTarget};
    use std::path::PathBuf;

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
