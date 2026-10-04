use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const ENDPOINT: &str = "https://api.xiaomimimo.com/v1/chat/completions";
const ASR_MODEL: &str = "mimo-v2.5-asr";
const TTS_MODEL: &str = "mimo-v2.5-tts";
const DEFAULT_VOICE: &str = "mimo_default";
pub const VOICE_EVENT: &str = "codev://voice";

static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceScope {
    Pi,
    Codex,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrConfig {
    pub language: String,
    pub enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsConfig {
    pub voice: String,
    pub mode: String,
    pub enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceScopeConfig {
    pub enabled: bool,
    pub asr: AsrConfig,
    pub tts: TtsConfig,
    #[serde(skip)]
    pub key: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceFile {
    version: u32,
    pi: VoiceScopeConfig,
    codex: VoiceScopeConfig,
    #[serde(default, rename = "piKey")]
    pi_key: Vec<u8>,
    #[serde(default, rename = "codexKey")]
    codex_key: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceScopeView {
    pub enabled: bool,
    pub asr: AsrConfig,
    pub tts: TtsConfig,
    pub has_key: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfigView {
    pub pi: VoiceScopeView,
    pub codex: VoiceScopeView,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfigInput {
    pub enabled: bool,
    pub asr: AsrConfig,
    pub tts: TtsConfig,
    pub key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStreamEvent {
    stream_id: u64,
    kind: &'static str,
    text: Option<String>,
    audio: Option<String>,
    done: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct VoiceState {
    lock: Mutex<()>,
}

fn default_asr() -> AsrConfig {
    AsrConfig { language: "zh".into(), enabled: false }
}

fn default_tts() -> TtsConfig {
    TtsConfig { voice: DEFAULT_VOICE.into(), mode: "manual".into(), enabled: false }
}

fn default_scope() -> VoiceScopeConfig {
    VoiceScopeConfig { enabled: false, asr: default_asr(), tts: default_tts(), key: String::new() }
}

fn default_file() -> VoiceFile {
    VoiceFile { version: 3, pi: default_scope(), codex: default_scope(), pi_key: Vec::new(), codex_key: Vec::new() }
}

fn config_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("Codev").join("voice.json"))
        .ok_or("无法确定 Codev 本地配置目录".into())
}

#[cfg(windows)]
fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("小米语音 key 保护失败".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut _); }
    Ok(result)
}

#[cfg(not(windows))]
fn crypt(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("小米语音 key 存储当前仅支持 Windows".into())
}

fn encrypt_key(key: &str) -> Result<Vec<u8>, String> { crypt(key.as_bytes(), false) }
fn decrypt_key(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(crypt(bytes, true)?).map_err(|_| "小米语音 key 解码失败".into())
}

fn read_file() -> Result<VoiceFile, String> {
    let path = config_path()?;
    if !path.exists() { return Ok(default_file()); }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let version = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|value| value.get("version").and_then(|version| version.as_u64())).unwrap_or(1);
    if version < 3 {
        let fresh = default_file();
        write_file(&fresh)?;
        return Ok(fresh);
    }
    let mut raw: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}));
    for scope_name in ["pi", "codex"] {
        let Some(scope) = raw.get_mut(scope_name) else { continue };
        if scope.get("asr").and_then(|asr| asr.get("language").filter(|language| language.is_string())).is_none() {
            scope["asr"] = serde_json::json!(default_asr());
        }
        if scope.get("tts").and_then(|tts| tts.get("voice").filter(|voice| voice.is_string())).is_none() {
            let mode = scope.pointer("/tts/mode").and_then(|mode| mode.as_str()).unwrap_or("manual");
            let enabled = scope.pointer("/tts/enabled").and_then(|enabled| enabled.as_bool()).unwrap_or(false);
            scope["tts"] = serde_json::json!({ "voice": DEFAULT_VOICE, "mode": mode, "enabled": enabled });
        }
    }
    let mut file: VoiceFile = serde_json::from_value(raw).unwrap_or_else(|_| default_file());
    file.pi.key = decrypt_key(&file.pi_key).unwrap_or_default();
    file.codex.key = decrypt_key(&file.codex_key).unwrap_or_default();
    if file.pi.tts.voice.trim().is_empty() { file.pi.tts.voice = DEFAULT_VOICE.into(); }
    if file.codex.tts.voice.trim().is_empty() { file.codex.tts.voice = DEFAULT_VOICE.into(); }
    if file.pi.tts.mode != "auto" { file.pi.tts.mode = "manual".into(); }
    if file.codex.tts.mode != "auto" { file.codex.tts.mode = "manual".into(); }
    Ok(file)
}

fn write_file(file: &VoiceFile) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let mut stored = file.clone();
    stored.pi_key = if stored.pi.key.trim().is_empty() { Vec::new() } else { encrypt_key(stored.pi.key.trim())? };
    stored.codex_key = if stored.codex.key.trim().is_empty() { Vec::new() } else { encrypt_key(stored.codex.key.trim())? };
    stored.pi.key.clear();
    stored.codex.key.clear();
    std::fs::write(path, serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn scope_ref(file: &VoiceFile, scope: VoiceScope) -> &VoiceScopeConfig {
    match scope { VoiceScope::Pi => &file.pi, VoiceScope::Codex => &file.codex }
}

fn scope_mut(file: &mut VoiceFile, scope: VoiceScope) -> &mut VoiceScopeConfig {
    match scope { VoiceScope::Pi => &mut file.pi, VoiceScope::Codex => &mut file.codex }
}

fn view_scope(scope: &VoiceScopeConfig) -> VoiceScopeView {
    VoiceScopeView { enabled: scope.enabled, asr: scope.asr.clone(), tts: scope.tts.clone(), has_key: !scope.key.trim().is_empty() }
}

fn config_view(file: &VoiceFile) -> VoiceConfigView {
    VoiceConfigView {
        pi: view_scope(&file.pi),
        codex: view_scope(&file.codex),
        path: config_path().map(|path| path.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn voice_config_list(state: State<'_, VoiceState>) -> Result<VoiceConfigView, String> {
    let _guard = state.lock.lock().map_err(|_| "语音配置正忙")?;
    Ok(config_view(&read_file()?))
}

#[tauri::command]
pub fn voice_config_read_secret(scope: VoiceScope, state: State<'_, VoiceState>) -> Result<String, String> {
    let _guard = state.lock.lock().map_err(|_| "语音配置正忙")?;
    Ok(scope_ref(&read_file()?, scope).key.clone())
}

#[tauri::command]
pub fn voice_config_save(scope: VoiceScope, input: VoiceConfigInput, state: State<'_, VoiceState>) -> Result<VoiceConfigView, String> {
    let _guard = state.lock.lock().map_err(|_| "语音配置正忙")?;
    let mut file = read_file()?;
    let target = scope_mut(&mut file, scope);
    target.enabled = input.enabled;
    target.asr = input.asr;
    target.tts = input.tts;
    if target.asr.language.trim().is_empty() { target.asr.language = "zh".into(); }
    if target.tts.voice.trim().is_empty() { target.tts.voice = DEFAULT_VOICE.into(); }
    if target.tts.mode != "auto" { target.tts.mode = "manual".into(); }
    if let Some(key) = input.key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty()) {
        target.key = key;
    }
    write_file(&file)?;
    Ok(config_view(&file))
}

#[tauri::command]
pub fn voice_config_copy_to_codex(state: State<'_, VoiceState>) -> Result<VoiceConfigView, String> {
    let _guard = state.lock.lock().map_err(|_| "语音配置正忙")?;
    let mut file = read_file()?;
    file.codex = file.pi.clone();
    file.codex_key = file.pi_key.clone();
    write_file(&file)?;
    Ok(config_view(&file))
}

fn enabled_scope(scope: VoiceScope) -> Result<VoiceScopeConfig, String> {
    let file = read_file()?;
    let config = scope_ref(&file, scope).clone();
    if !config.enabled { return Err("请先启用小米语音".into()); }
    if config.key.trim().is_empty() { return Err("请先填写小米 API Key".into()); }
    Ok(config)
}

fn emit_stream(app: &AppHandle, event: VoiceStreamEvent) {
    let _ = app.emit(VOICE_EVENT, event);
}

fn response_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let detail = response.into_string().unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&detail).ok().and_then(|value| value.pointer("/error/message").and_then(|message| message.as_str()).map(str::to_string)).filter(|message| !message.is_empty());
            message.unwrap_or_else(|| format!("小米语音返回 HTTP {status} {detail}"))
        }
        other => format!("小米语音请求失败：{other}"),
    }
}

fn post_stream(app: AppHandle, stream_id: u64, kind: &'static str, key: String, payload: serde_json::Value) -> Result<(), String> {
    let response = ureq::post(ENDPOINT)
        .timeout(Duration::from_secs(180))
        .set("api-key", &key)
        .set("Content-Type", "application/json")
        .set("Accept", "text/event-stream")
        .send_json(payload)
        .map_err(response_error)?;
    let reader = BufReader::new(response.into_reader());
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() { continue; }
        if data == "[DONE]" { break; }
        let value: serde_json::Value = serde_json::from_str(data).map_err(|error| format!("小米语音响应无法解析：{error}"))?;
        if let Some(message) = value.get("error").and_then(|error| error.get("message")).and_then(|message| message.as_str()) {
            return Err(message.to_string());
        }
        let delta = value.pointer("/choices/0/delta").or_else(|| value.pointer("/choices/0/message"));
        if kind == "asr" {
            let text = delta.and_then(|item| item.get("content")).and_then(|content| content.as_str()).unwrap_or_default();
            if !text.is_empty() {
                emit_stream(&app, VoiceStreamEvent { stream_id, kind, text: Some(text.to_string()), audio: None, done: false, error: None });
            }
        } else if let Some(audio) = delta.and_then(|item| item.get("audio")).and_then(|audio| audio.get("data")).and_then(|data| data.as_str()) {
            if !audio.is_empty() {
                emit_stream(&app, VoiceStreamEvent { stream_id, kind, text: None, audio: Some(audio.to_string()), done: false, error: None });
            }
        }
    }
    emit_stream(&app, VoiceStreamEvent { stream_id, kind, text: None, audio: None, done: true, error: None });
    Ok(())
}

fn fail_stream(app: &AppHandle, stream_id: u64, kind: &'static str, error: String) {
    emit_stream(app, VoiceStreamEvent { stream_id, kind, text: None, audio: None, done: true, error: Some(error) });
}

#[tauri::command]
pub async fn voice_asr_start(app: AppHandle, scope: VoiceScope, audio: Vec<u8>) -> Result<u64, String> {
    let config = enabled_scope(scope)?;
    if !config.asr.enabled { return Err("请先启用语音输入".into()); }
    let wav = wav_16k(&audio)?;
    let language = if config.asr.language == "en" { "en" } else if config.asr.language == "auto" { "auto" } else { "zh" };
    let payload = serde_json::json!({
        "model": ASR_MODEL,
        "stream": true,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": { "data": format!("data:audio/wav;base64,{}", base64_encode(&wav)) }
            }]
        }],
        "asr_options": { "language": language }
    });
    let stream_id = NEXT_STREAM.fetch_add(1, Ordering::Relaxed);
    let key = config.key;
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = post_stream(app.clone(), stream_id, "asr", key, payload) { fail_stream(&app, stream_id, "asr", error); }
    });
    Ok(stream_id)
}

#[tauri::command]
pub async fn voice_tts_start(app: AppHandle, scope: VoiceScope, text: String) -> Result<u64, String> {
    let config = enabled_scope(scope)?;
    if !config.tts.enabled { return Err("请先启用语音播放".into()); }
    let text = text.trim();
    if text.is_empty() { return Err("没有可朗读的文本".into()); }
    let voice = if config.tts.voice.trim().is_empty() { DEFAULT_VOICE } else { config.tts.voice.trim() };
    let payload = serde_json::json!({
        "model": TTS_MODEL,
        "stream": true,
        "messages": [{ "role": "assistant", "content": text }],
        "audio": { "format": "pcm16", "voice": voice }
    });
    let stream_id = NEXT_STREAM.fetch_add(1, Ordering::Relaxed);
    let key = config.key;
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = post_stream(app.clone(), stream_id, "tts", key, payload) { fail_stream(&app, stream_id, "tts", error); }
    });
    Ok(stream_id)
}

fn wav_16k(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() < 44 || &input[0..4] != b"RIFF" || &input[8..12] != b"WAVE" { return Err("录音格式不是 WAV，请重新录制".into()); }
    let mut cursor = 12usize;
    let mut sample_rate = 0u32;
    let mut channels = 0usize;
    let mut bits = 0u16;
    let mut data = Vec::new();
    while cursor + 8 <= input.len() {
        let kind = &input[cursor..cursor + 4];
        let size = u32::from_le_bytes(input[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
        let start = cursor + 8;
        let end = start + size;
        if end > input.len() { return Err("录音文件不完整".into()); }
        if kind == b"fmt " && size >= 16 {
            channels = u16::from_le_bytes(input[start + 2..start + 4].try_into().unwrap()) as usize;
            sample_rate = u32::from_le_bytes(input[start + 4..start + 8].try_into().unwrap());
            bits = u16::from_le_bytes(input[start + 14..start + 16].try_into().unwrap());
        } else if kind == b"data" {
            data.extend_from_slice(&input[start..end]);
        }
        cursor = end + (size & 1);
    }
    if channels == 0 || sample_rate == 0 || bits != 16 || data.len() < channels * 2 { return Err("录音格式不受支持，请重新录制".into()); }
    let frames = data.len() / (channels * 2);
    if frames < sample_rate as usize / 10 { return Err("录音太短".into()); }
    let mut mono = Vec::with_capacity(frames);
    for index in 0..frames {
        let mut sum = 0i32;
        for channel in 0..channels {
            let offset = (index * channels + channel) * 2;
            sum += i16::from_le_bytes(data[offset..offset + 2].try_into().unwrap()) as i32;
        }
        mono.push((sum / channels as i32) as f32 / i16::MAX as f32);
    }
    let ratio = sample_rate as f64 / 16_000.0;
    let length = ((mono.len() as f64) / ratio).floor() as usize;
    let mut pcm = Vec::with_capacity(length * 2);
    for index in 0..length {
        let source = ((index as f64) * ratio).floor() as usize;
        let sample = (mono[source.min(mono.len() - 1)] * i16::MAX as f32) as i16;
        pcm.extend_from_slice(&sample.to_le_bytes());
    }
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&(16_000u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend(pcm);
    Ok(wav)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let (value, padding) = match chunk {
            [a, b, c] => ((*a as u32) << 16 | (*b as u32) << 8 | *c as u32, 0),
            [a, b] => ((*a as u32) << 16 | (*b as u32) << 8, 1),
            [a] => ((*a as u32) << 16, 2),
            _ => (0, 0),
        };
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if padding == 2 { '=' } else { TABLE[((value >> 6) & 63) as usize] as char });
        output.push(if padding > 0 { '=' } else { TABLE[(value & 63) as usize] as char });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_disabled_manual_and_single_key() {
        let file = default_file();
        assert!(!file.pi.enabled && !file.codex.enabled);
        assert_eq!(file.pi.tts.mode, "manual");
        assert_eq!(file.pi.tts.voice, "mimo_default");
        assert!(file.pi.key.is_empty());
    }

    #[test]
    fn base64_matches_standard_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }
}
