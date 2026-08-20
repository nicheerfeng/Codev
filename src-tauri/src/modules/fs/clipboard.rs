use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileClipboard {
    pub paths: Vec<String>,
    pub mode: String,
}

/// 读取系统文件剪贴板中的文件路径和复制/剪切状态。
#[tauri::command]
pub fn fs_get_file_clipboard() -> Option<ExternalFileClipboard> {
    #[cfg(windows)]
    {
        return read_windows_file_clipboard();
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
/// 从 Windows CF_HDROP 剪贴板读取外部文件路径。
fn read_windows_file_clipboard() -> Option<ExternalFileClipboard> {
    use std::ptr;

    use windows_sys::Win32::Foundation::HGLOBAL;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::{CF_HDROP, DROPEFFECT_MOVE};
    use windows_sys::Win32::UI::Shell::{
        DragQueryFileW, CFSTR_PREFERREDDROPEFFECT, HDROP,
    };

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP as u32) == 0 {
            return None;
        }
        if OpenClipboard(ptr::null_mut()) == 0 {
            return None;
        }

        let result = (|| {
            let data = GetClipboardData(CF_HDROP as u32);
            if data.is_null() {
                return None;
            }
            let count = DragQueryFileW(data as HDROP, u32::MAX, ptr::null_mut(), 0);
            let mut paths = Vec::with_capacity(count as usize);
            for index in 0..count {
                let length = DragQueryFileW(data as HDROP, index, ptr::null_mut(), 0);
                let mut buffer = vec![0_u16; length as usize + 1];
                let written = DragQueryFileW(
                    data as HDROP,
                    index,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                );
                if written > 0 {
                    paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
                }
            }
            if paths.is_empty() {
                return None;
            }

            let format = RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT);
            let mode = if format == 0 {
                "copy"
            } else {
                let effect_data = GetClipboardData(format);
                if effect_data.is_null() {
                    "copy"
                } else {
                    let locked = GlobalLock(effect_data as HGLOBAL) as *const u32;
                    let is_move = !locked.is_null() && (*locked & DROPEFFECT_MOVE) != 0;
                    if !locked.is_null() {
                        let _ = GlobalUnlock(effect_data as HGLOBAL);
                    }
                    if is_move { "move" } else { "copy" }
                }
            };
            Some(ExternalFileClipboard {
                paths,
                mode: mode.to_string(),
            })
        })();

        CloseClipboard();
        result
    }
}
