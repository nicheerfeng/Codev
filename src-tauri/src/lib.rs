pub mod modules;

use modules::{fs, history, pty, workspace};
use std::path::PathBuf;
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

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
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

fn parse_launch_target() -> LaunchTarget {
    let entries = std::env::args()
        .skip(1)
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

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

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

    let builder = tauri::Builder::default();
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
            fs::file::fs_read_text_window,
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
                        .filter(|p| p.is_file())
                        .map(LaunchEntry::File)
                        .collect();
                    let target = resolve_launch_target(entries);
                    if target.files.is_empty() {
                        return;
                    }
                    if let Some(dir) = &target.dir {
                        if let Some(registry) = _app.try_state::<workspace::WorkspaceRegistry>() {
                            let _ = registry.authorize(dir);
                        }
                        if let Some(state) = _app.try_state::<LaunchDir>() {
                            *state.0.lock().expect("LaunchDir mutex poisoned") = Some(dir.clone());
                        }
                    }
                    if let Some(state) = _app.try_state::<LaunchFiles>() {
                        *state.0.lock().expect("LaunchFiles mutex poisoned") = target.files.clone();
                    }
                    let _ = _app.emit("terax:open-file", target.files);
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
