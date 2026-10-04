// Prevents a console window from appearing on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager, State};

// ─── App State ───────────────────────────────────────────────────────────────

struct AppState {
    /// Set to true to request cancellation of the running compression.
    cancel_flag: Arc<AtomicBool>,
    /// Holds the currently running FFmpeg child process so it can be killed.
    active_proc: Arc<Mutex<Option<Child>>>,
    launch_paths: Mutex<Vec<String>>,
    temp_files: Arc<Mutex<HashSet<PathBuf>>>,
}

const TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(30 * 60);
const TEMP_SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_file_path(prefix: &str, extension: &str) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "{}_{}_{}_{}.{}",
        prefix,
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default(),
        counter,
        extension
    ))
}

fn register_temp_file(registry: &Arc<Mutex<HashSet<PathBuf>>>, path: &Path) {
    if let Ok(mut files) = registry.lock() {
        files.insert(path.to_path_buf());
    }
}

fn unregister_temp_file(registry: &Arc<Mutex<HashSet<PathBuf>>>, path: &Path) {
    if let Ok(mut files) = registry.lock() {
        files.remove(path);
    }
}

struct TempFileGuard {
    registry: Arc<Mutex<HashSet<PathBuf>>>,
    path: PathBuf,
}

impl TempFileGuard {
    fn new(registry: Arc<Mutex<HashSet<PathBuf>>>, path: PathBuf) -> Self {
        register_temp_file(&registry, &path);
        Self { registry, path }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        unregister_temp_file(&self.registry, &self.path);
    }
}

fn cleanup_temp_files(registry: &Arc<Mutex<HashSet<PathBuf>>>) {
    let active_files = registry.lock().map(|files| files.clone()).unwrap_or_default();
    let cutoff = SystemTime::now().checked_sub(TEMP_FILE_MAX_AGE);
    let entries = match fs::read_dir(std::env::temp_dir()) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_owned = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.starts_with("hydraulic_preview_") || name.starts_with("hydraulic_pass_")
            })
            .unwrap_or(false);
        let is_active = active_files.iter().any(|active| {
            path == *active
                || path
                    .to_string_lossy()
                    .starts_with(active.to_string_lossy().as_ref())
        });
        if !is_owned || is_active {
            continue;
        }

        let is_old = match (cutoff, fs::metadata(&path).and_then(|metadata| metadata.modified())) {
            (Some(cutoff), Ok(modified)) => modified <= cutoff,
            _ => false,
        };
        if is_old {
            let _ = fs::remove_file(path);
        }
    }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn media_binary(program: &str) -> Option<PathBuf> {
    let bundled_locations = [
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("resources"))),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")),
    ];

    for resource_dir in bundled_locations.into_iter().flatten() {
        let path = resource_dir.join("ffmpeg").join(if cfg!(windows) {
            format!("{}.exe", program)
        } else {
            program.to_string()
        });
        if path.is_file() {
            return Some(path);
        }
    }

    which::which(program).ok()
}

fn media_command(program: &str) -> Command {
    let mut command = Command::new(media_binary(program).unwrap_or_else(|| PathBuf::from(program)));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(0x08000000);
    }
    command
}

fn check_ffmpeg_available() -> bool {
    media_binary("ffmpeg").is_some() && media_binary("ffprobe").is_some()
}

fn get_media_info(filepath: &str) -> Result<Value, String> {
    let output = media_command("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            filepath,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ffprobe failed to launch: {}", e))?;

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("ffprobe output parse error: {}", e))
}

fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let sec: f64 = parts[2].parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + sec)
        }
        2 => {
            let m: f64 = parts[0].parse().ok()?;
            let sec: f64 = parts[1].parse().ok()?;
            Some(m * 60.0 + sec)
        }
        1 => s.parse().ok(),
        _ => None,
    }
}

fn settings_file_path() -> PathBuf {
    let base: PathBuf = if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default())
    } else {
        dirs::home_dir().unwrap_or_default()
    };
    let dir = base.join("Hydraulic");
    fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

/// Evaluate JS in the main window — mirrors Python's `window.evaluate_js()`.
/// Used to fire the existing `onItemDone / onItemCancelled / onItemError` callbacks
/// without requiring any frontend changes.
fn eval_js(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

fn emit_progress(app: &AppHandle, item_id: &str, progress: f64, eta: Option<f64>) {
    let id_json = serde_json::to_string(item_id).unwrap_or_default();
    let eta_json = serde_json::to_string(&eta).unwrap_or("null".into());
    eval_js(
        app,
        &format!("onItemProgress({}, {:.4}, {})", id_json, progress, eta_json),
    );
}

fn emit_native_dropped_paths(app: &AppHandle, paths: &[PathBuf]) {
    let as_strings: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let payload = serde_json::to_string(&as_strings).unwrap_or_else(|_| "[]".to_string());
    eval_js(
        app,
        &format!(
            "if (window.handleNativeDroppedPaths) window.handleNativeDroppedPaths({});",
            payload
        ),
    );
}

fn supported_video_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| {
            let file = Path::new(path);
            file.is_file()
                && matches!(
                    file.extension().and_then(|ext| ext.to_str()),
                    Some("mp4" | "MP4" | "mkv" | "MKV" | "mov" | "MOV")
                )
        })
        .collect()
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ─── FFmpeg Pass Runner ───────────────────────────────────────────────────────

/// Runs a single FFmpeg command, streaming progress via `progress_cb`.
/// Returns `Err("CANCELLED")` if the cancel flag was raised.
fn run_pass(
    cmd: &[String],
    duration: f64,
    cancel_flag: Arc<AtomicBool>,
    active_proc: Arc<Mutex<Option<Child>>>,
    mut progress_cb: impl FnMut(f64),
) -> Result<(), String> {
    let mut child = media_command(&cmd[0])
        .args(&cmd[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    // Pull stdout out of the child so we can read it while also keeping
    // the child alive in the mutex for cancellation.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture ffmpeg stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture ffmpeg stderr".to_string())?;
    let stderr_thread = std::thread::spawn(move || {
        let mut output = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut output);
        output
    });

    {
        let mut guard = active_proc.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let reader = BufReader::new(stdout);
    let prefix = "out_time_us=";

    for line in reader.lines() {
        // Check cancel on every line
        if cancel_flag.load(Ordering::SeqCst) {
            if let Ok(mut guard) = active_proc.lock() {
                if let Some(mut proc) = guard.take() {
                    let _ = proc.kill();
                    let _ = proc.wait();
                }
            }
            return Err("CANCELLED".to_string());
        }

        if let Ok(line) = line {
            let line = line.trim().to_string();
            if line.starts_with(prefix) {
                if let Ok(us) = line[prefix.len()..].parse::<u64>() {
                    let secs = us as f64 / 1_000_000.0;
                    progress_cb((secs / duration).min(1.0));
                }
            }
        }
    }

    // Wait for the process to finish and collect it from the mutex
    let exit_status = {
        let mut guard = active_proc.lock().map_err(|e| e.to_string())?;
        if let Some(mut proc) = guard.take() {
            proc.wait().map_err(|e| e.to_string())?
        } else {
            // Already cleaned up (cancelled mid-flight by another thread)
            return Err("CANCELLED".to_string());
        }
    };

    if cancel_flag.load(Ordering::SeqCst) {
        return Err("CANCELLED".to_string());
    }

    if !exit_status.success() {
        let stderr = stderr_thread.join().unwrap_or_default();
        let details = stderr.trim();
        return Err(if details.is_empty() {
            format!("FFmpeg exited with code {:?}", exit_status.code())
        } else {
            format!("FFmpeg exited with code {:?}: {}", exit_status.code(), details)
        });
    }

    let _ = stderr_thread.join();

    Ok(())
}

// ─── Commands: Misc ──────────────────────────────────────────────────────────

#[tauri::command]
fn check_ffmpeg() -> bool {
    check_ffmpeg_available()
}

#[tauri::command]
fn get_launch_paths(state: State<AppState>) -> Vec<String> {
    state
        .launch_paths
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(settings: Value) -> bool {
    match serde_json::to_string(&settings) {
        Ok(s) => fs::write(settings_file_path(), s).is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
fn load_settings() -> Value {
    fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

#[tauri::command]
fn cancel_compression(state: State<AppState>) -> bool {
    state.cancel_flag.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.active_proc.lock() {
        if let Some(proc) = guard.as_mut() {
            let _ = proc.kill();
        }
    }
    true
}

// ─── Commands: Media Info ─────────────────────────────────────────────────────

#[tauri::command]
fn get_thumbnail(filepath: String) -> Option<String> {
    if !check_ffmpeg_available() {
        return None;
    }

    let tmp_path = temp_file_path("hydraulic_thumb", "jpg");

    for seek in ["00:00:01", "00:00:00"] {
        let _ = fs::remove_file(&tmp_path); // clean any leftover

        let status = media_command("ffmpeg")
            .args([
                "-y",
                "-ss",
                seek,
                "-i",
                &filepath,
                "-vframes",
                "1",
                "-vf",
                "scale=320:-1",
                "-q:v",
                "4",
                tmp_path.to_str().unwrap_or(""),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if status.map(|s| s.success()).unwrap_or(false) {
            if let Ok(data) = fs::read(&tmp_path) {
                if !data.is_empty() {
                    let b64 = BASE64.encode(&data);
                    let _ = fs::remove_file(&tmp_path);
                    return Some(format!("data:image/jpeg;base64,{}", b64));
                }
            }
        }
        let _ = fs::remove_file(&tmp_path);
    }
    None
}

#[derive(Serialize, Deserialize)]
struct AudioTrack {
    index: usize,
    codec: String,
    channels: String,
    language: String,
    title: String,
}

#[tauri::command]
fn get_audio_tracks(filepath: String) -> Vec<AudioTrack> {
    let info = match get_media_info(&filepath) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let empty = vec![];
    let streams = info["streams"].as_array().unwrap_or(&empty);
    let mut tracks = vec![];
    let mut audio_idx = 0usize;

    for stream in streams {
        if stream["codec_type"].as_str() != Some("audio") {
            continue;
        }
        let channels = stream["channels"].as_u64().unwrap_or(0) as u32;
        let ch_label = match channels {
            1 => "Mono".to_string(),
            2 => "Stereo".to_string(),
            6 => "5.1".to_string(),
            8 => "7.1".to_string(),
            n => format!("{}ch", n),
        };
        let tags = &stream["tags"];
        tracks.push(AudioTrack {
            index: audio_idx,
            codec: stream["codec_name"]
                .as_str()
                .unwrap_or("?")
                .to_uppercase(),
            channels: ch_label,
            language: tags["language"].as_str().unwrap_or("").to_string(),
            title: tags["title"].as_str().unwrap_or("").to_string(),
        });
        audio_idx += 1;
    }
    tracks
}

// ─── Commands: Video Serving ─────────────────────────────────────────────────
//
// In pywebview, Hydraulic served videos via a local HTTP server. In Tauri, the
// `asset://` protocol (via `convertFileSrc` on the JS side) handles this
// natively with range-request support. These commands return raw paths; the
// frontend calls `window.__TAURI__.core.convertFileSrc(path)` before using
// them as video `src` values. See COPILOT_PROMPT.md for the JS changes.

#[tauri::command]
fn get_file_url(filepath: String) -> String {
    // Return the raw path — JS wraps it with convertFileSrc()
    filepath
}

#[tauri::command]
fn get_file_size(filepath: String) -> Result<u64, String> {
    fs::metadata(filepath)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("Failed to read output file metadata: {}", error))
}

#[derive(Serialize)]
struct MixedPreviewResult {
    url: String,
    tmp: Option<String>,
}

#[tauri::command]
fn get_mixed_preview_url(
    state: State<AppState>,
    filepath: String,
    audio_volumes: Option<Vec<f64>>,
) -> MixedPreviewResult {
    let fallback = MixedPreviewResult {
        url: filepath.clone(),
        tmp: None,
    };

    let info = match get_media_info(&filepath) {
        Ok(v) => v,
        Err(_) => return fallback,
    };
    let empty = vec![];
    let streams = info["streams"].as_array().unwrap_or(&empty);
    let n = streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("audio"))
        .count();

    if n <= 1 {
        return MixedPreviewResult {
            url: filepath,
            tmp: None,
        };
    }

    let src_ext = Path::new(&filepath)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");

    let tmp_path = temp_file_path("hydraulic_preview", src_ext);

    let filter_in: String = (0..n)
        .enumerate()
        .map(|(output_index, input_index)| {
            let volume = audio_volumes
                .as_ref()
                .and_then(|volumes| volumes.get(input_index).copied())
                .unwrap_or(1.0)
                .clamp(0.0, 2.0);
            format!(
                "[0:a:{}]volume={}[a{}];",
                input_index, volume, output_index
            )
        })
        .collect();
    let inputs: String = (0..n).map(|i| format!("[a{}]", i)).collect();
    let amix = format!("{}{}amix=inputs={}:normalize=0[aout]", filter_in, inputs, n);

    let status = media_command("ffmpeg")
        .args([
            "-y",
            "-i",
            &filepath,
            "-filter_complex",
            &amix,
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            tmp_path.to_str().unwrap_or(""),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let tmp_str = tmp_path.to_string_lossy().to_string();

    if status.map(|s| s.success()).unwrap_or(false)
        && tmp_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
    {
        register_temp_file(&state.temp_files, &tmp_path);
        MixedPreviewResult {
            url: tmp_str.clone(),
            tmp: Some(tmp_str),
        }
    } else {
        let _ = fs::remove_file(&tmp_path);
        MixedPreviewResult {
            url: filepath,
            tmp: None,
        }
    }
}

#[tauri::command]
fn delete_temp_file(state: State<AppState>, tmp_path: String) {
    if !tmp_path.is_empty() {
        let path = PathBuf::from(&tmp_path);
        unregister_temp_file(&state.temp_files, &path);
        let _ = fs::remove_file(path);
    }
}

// ─── Commands: File / System Operations ──────────────────────────────────────

#[tauri::command]
fn open_file(filepath: String) {
    #[cfg(target_os = "windows")]
    {
        let norm = filepath.replace('/', "\\");
        let _ = Command::new("explorer")
            .args(["/select,", &norm])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").args(["-R", &filepath]).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let dir = Path::new(&filepath)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(filepath);
        let _ = Command::new("xdg-open").arg(&dir).spawn();
    }
}

#[tauri::command]
fn open_in_media_player(filepath: String) -> bool {
    if !Path::new(&filepath).is_file() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", &filepath])
            .spawn()
            .is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&filepath).spawn().is_ok()
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&filepath).spawn().is_ok()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    false
}

#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/c", "start", "", &url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Option<String> {
    let old = Path::new(&old_path);
    if !old.is_file() {
        return None;
    }
    let new_path = old.parent()?.join(&new_name);
    if new_path.exists() {
        return None; // don't overwrite existing files
    }
    fs::rename(old, &new_path).ok()?;
    Some(new_path.to_string_lossy().to_string())
}

#[tauri::command]
fn resolve_dropped_path(filename: String) -> Option<String> {
    let path = Path::new(&filename);
    if path.is_absolute() && path.is_file() {
        return Some(filename);
    }

    let basename = path.file_name()?.to_string_lossy().to_string();
    let home = dirs::home_dir()?;
    let search_dirs = vec![
        home.clone(),
        home.join("Desktop"),
        home.join("Downloads"),
        home.join("Videos"),
        home.join("Movies"),
        home.join("Documents"),
    ];

    // First pass: top-level of each search dir
    for dir in &search_dirs {
        let candidate = dir.join(&basename);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Second pass: one level of sub-directories
    for dir in &search_dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .map(|t| t.is_dir())
                    .unwrap_or(false)
                {
                    let candidate = entry.path().join(&basename);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

// ─── Commands: Window Controls ───────────────────────────────────────────────

#[tauri::command]
fn window_minimize(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.minimize().is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn window_toggle_maximize(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        let is_max = w.is_maximized().unwrap_or(false);
        if is_max {
            w.unmaximize().is_ok()
        } else {
            w.maximize().is_ok()
        }
    } else {
        false
    }
}

#[tauri::command]
fn window_close(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.close().is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn set_window_fullscreen(app: AppHandle, enabled: bool) -> bool {
    app.get_webview_window("main")
        .map(|w| w.set_fullscreen(enabled).is_ok())
        .unwrap_or(false)
}

// ─── Commands: File Dialogs ───────────────────────────────────────────────────

#[tauri::command]
async fn open_file_dialog(app: AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Video Files",
            &["mp4", "mkv", "mov"],
        )
        .pick_files(move |result| {
            let _ = tx.send(result);
        });

    rx.await
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |result| {
        let _ = tx.send(result);
    });

    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

// ─── Commands: Compression ────────────────────────────────────────────────────

#[tauri::command]
fn compress(
    app: AppHandle,
    state: State<AppState>,
    item_id: String,
    filepath: String,
    target_size_mb: f64,
    audio_kbps: u32,
    use_gpu: bool,
    combine_audio: bool,
    two_pass: bool,
    output_dir: Option<String>,
    format_ext: String,
    trim_start: Option<String>,
    trim_end: Option<String>,
    enabled_tracks: Option<Vec<usize>>,
    audio_volumes: Option<Vec<f64>>,
) {
    // Reset cancel flag before starting
    state.cancel_flag.store(false, Ordering::SeqCst);

    let cancel_flag = state.cancel_flag.clone();
    let active_proc = state.active_proc.clone();
    let temp_files = state.temp_files.clone();

    std::thread::spawn(move || {
        match do_compress(
            &app,
            &item_id,
            &filepath,
            target_size_mb,
            audio_kbps,
            use_gpu,
            combine_audio,
            two_pass,
            output_dir.as_deref(),
            &format_ext,
            trim_start.as_deref(),
            trim_end.as_deref(),
            enabled_tracks.as_deref(),
            audio_volumes.as_deref(),
            cancel_flag,
            active_proc,
            temp_files,
        ) {
            Ok(output_file) => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                let path_json = serde_json::to_string(&output_file).unwrap_or_default();
                eval_js(&app, &format!("onItemDone({}, {})", id_json, path_json));
            }
            Err(e) if e == "CANCELLED" => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                eval_js(
                    &app,
                    &format!("onItemCancelled({}, \"Compression cancelled\")", id_json),
                );
            }
            Err(e) => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                let err_json = serde_json::to_string(&e).unwrap_or_default();
                eval_js(&app, &format!("onItemError({}, {})", id_json, err_json));
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn do_compress(
    app: &AppHandle,
    item_id: &str,
    input_file: &str,
    target_size_mb: f64,
    audio_kbps: u32,
    use_gpu: bool,
    combine_audio: bool,
    two_pass: bool,
    output_dir: Option<&str>,
    format_ext: &str,
    trim_start: Option<&str>,
    trim_end: Option<&str>,
    enabled_tracks: Option<&[usize]>,
    audio_volumes: Option<&[f64]>,
    cancel_flag: Arc<AtomicBool>,
    active_proc: Arc<Mutex<Option<Child>>>,
    temp_files: Arc<Mutex<HashSet<PathBuf>>>,
) -> Result<String, String> {
    if !Path::new(input_file).is_file() {
        return Err(format!("File not found: {}", input_file));
    }

    let info = get_media_info(input_file)?;
    let duration: f64 = info["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Could not read video duration".to_string())?;

    let t_start = trim_start.and_then(parse_time);
    let t_end = trim_end.and_then(parse_time);

    let eff_start = t_start.unwrap_or(0.0);
    let eff_end = t_end.map(|e| e.min(duration)).unwrap_or(duration);
    let eff_duration = (eff_end - eff_start).max(0.1);

    // ── Output format ────────────────────────────────────────────────────────
    let src_ext = Path::new(input_file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let out_ext = if format_ext == "original" {
        format!(".{}", src_ext)
    } else {
        format!(".{}", format_ext)
    };
    let use_webm = out_ext == ".webm";
    let use_gif = out_ext == ".gif";

    // ── Bitrate budget ───────────────────────────────────────────────────────
    let target_bits = target_size_mb * 8.0 * 1024.0 * 1024.0 * 0.96; // 4% safety margin

    let empty = vec![];
    let all_streams = info["streams"].as_array().unwrap_or(&empty);
    let n_audio = all_streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("audio"))
        .count();

    let active: Vec<usize> = match enabled_tracks {
        Some(tracks) if !tracks.is_empty() => {
            tracks.iter().filter(|&&i| i < n_audio).copied().collect()
        }
        _ => (0..n_audio).collect(),
    };
    let n_active = active.len();

    let audio_stream_count: usize = if n_active == 0 {
        0
    } else if combine_audio && n_active > 1 {
        1
    } else {
        n_active
    };

    let audio_bits = audio_kbps as f64 * 1000.0 * eff_duration * audio_stream_count as f64;
    let mut video_bitrate =
        ((target_bits - audio_bits) / eff_duration).max(50_000.0) as u64;

    // Safety valve: overshoot protection for short clips
    let estimated_overhead_bits = if eff_duration < 10.0 {
        (2_000_000.0_f64).max(500_000.0 + 100_000.0 * eff_duration) * 8.0
    } else {
        (500_000.0 + 50_000.0 * eff_duration) * 8.0
    };
    let estimated_output_bits =
        video_bitrate as f64 * eff_duration + audio_bits + estimated_overhead_bits;

    if estimated_output_bits > target_bits {
        let safety_buffer = target_bits * 0.03;
        let available = target_bits - audio_bits - safety_buffer;
        video_bitrate = (available / eff_duration).max(50_000.0) as u64;
    }

    // ── Output path ──────────────────────────────────────────────────────────
    let stem = Path::new(input_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let base_name = format!("{}_compressed{}", stem, out_ext);
    let out_dir = output_dir
        .filter(|d| Path::new(d).is_dir())
        .map(|d| d.to_string())
        .unwrap_or_else(|| {
            Path::new(input_file)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    let output_file = Path::new(&out_dir)
        .join(&base_name)
        .to_string_lossy()
        .to_string();

    // ── FFmpeg argument blocks ────────────────────────────────────────────────
    let mut seek_args: Vec<String> = vec![];
    if let Some(ts) = t_start {
        seek_args.extend(["-ss".into(), ts.to_string()]);
    }

    let mut dur_args: Vec<String> = vec![];
    if t_start.is_some() || t_end.is_some() {
        dur_args.extend(["-t".into(), eff_duration.to_string()]);
    }

    let volume_for = |index: usize| {
        audio_volumes
            .and_then(|volumes| volumes.get(index).copied())
            .unwrap_or(1.0)
            .clamp(0.0, 2.0)
    };
    let has_custom_volume = active
        .iter()
        .any(|&index| (volume_for(index) - 1.0).abs() > 0.001);

    let audio_map: Vec<String> = if use_gif {
        vec![]
    } else if (combine_audio && n_active > 1) || has_custom_volume {
        let filter_in: String = active
            .iter()
            .enumerate()
            .map(|(output_index, input_index)| {
                let volume = volume_for(*input_index);
                format!("[0:a:{}]volume={}[a{}];", input_index, volume, output_index)
            })
            .collect();
        let inputs = (0..n_active)
            .map(|index| format!("[a{}]", index))
            .collect::<String>();
        if combine_audio && n_active > 1 {
            vec![
                "-filter_complex".into(),
                format!("{}{}amix=inputs={}:dropout_transition=0[aout]", filter_in, inputs, n_active),
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "[aout]".into(),
            ]
        } else {
            let mut mapped = vec!["-filter_complex".into(), filter_in];
            mapped.extend(["-map".into(), "0:v".into()]);
            for index in 0..n_active {
                mapped.extend(["-map".into(), format!("[a{}]", index)]);
            }
            mapped
        }
    } else if n_active > 0 {
        let mut m = vec!["-map".into(), "0:v".into()];
        for i in &active {
            m.extend(["-map".into(), format!("0:a:{}", i)]);
        }
        m
    } else {
        vec!["-map".into(), "0:v".into()]
    };

    let audio_encode: Vec<String> = if n_active > 0 && !use_gif {
        if use_webm {
            vec![
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                format!("{}k", audio_kbps),
            ]
        } else {
            vec![
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{}k", audio_kbps),
            ]
        }
    } else {
        vec![]
    };

    let bv = video_bitrate.to_string();
    let bv_flags: Vec<String> = if use_gif {
        vec![]
    } else {
        vec![
            "-b:v".into(),
            bv.clone(),
            "-maxrate".into(),
            bv.clone(),
            "-bufsize".into(),
            (video_bitrate * 2).to_string(),
        ]
    };

    let faststart: Vec<String> = if !use_webm && !use_gif {
        vec!["-movflags".into(), "+faststart".into()]
    } else {
        vec![]
    };

    let gif_args: Vec<String> = if use_gif {
        vec![
            "-filter_complex".into(),
            "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse[v]".into(),
            "-map".into(),
            "[v]".into(),
            "-f".into(),
            "gif".into(),
            "-pix_fmt".into(),
            "rgb8".into(),
            "-loop".into(),
            "0".into(),
            "-an".into(),
        ]
    } else {
        vec![]
    };

    let passlog = std::env::temp_dir()
        .join(format!("hydraulic_pass_{}", item_id))
        .to_string_lossy()
        .to_string();
    let _passlog_guard = if two_pass && !use_gif {
        Some(TempFileGuard::new(temp_files, PathBuf::from(&passlog)))
    } else {
        None
    };

    let (p1_codec, p2_codec, s_codec): (Vec<String>, Vec<String>, Vec<String>) = if use_gif {
        (vec![], vec![], vec!["-c:v".into(), "gif".into()])
    } else if use_webm {
        (
            vec![
                "-c:v".into(), "libvpx-vp9".into(),
                "-pass".into(), "1".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec![
                "-c:v".into(), "libvpx-vp9".into(),
                "-pass".into(), "2".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec!["-c:v".into(), "libvpx-vp9".into()],
        )
    } else if use_gpu {
        (
            vec!["-c:v".into(), "h264_nvenc".into(), "-rc".into(), "vbr".into(), "-2pass".into(), "1".into()],
            vec!["-c:v".into(), "h264_nvenc".into(), "-rc".into(), "vbr".into(), "-2pass".into(), "1".into()],
            vec!["-c:v".into(), "h264_nvenc".into()],
        )
    } else {
        (
            vec![
                "-c:v".into(), "libx264".into(),
                "-pass".into(), "1".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec![
                "-c:v".into(), "libx264".into(),
                "-pass".into(), "2".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec!["-c:v".into(), "libx264".into()],
        )
    };

    let base_args: Vec<String> = vec![
        "ffmpeg".into(), "-y".into(),
        "-progress".into(), "pipe:1".into(),
        "-nostats".into(),
    ];

    // ── Run passes ───────────────────────────────────────────────────────────
    if two_pass && !use_gif {
        // ── Pass 1 ──────────────────────────────────────────────────────────
        let p1: Vec<String> = [
            base_args.clone(),
            seek_args.clone(),
            vec!["-i".into(), input_file.to_string()],
            dur_args.clone(),
            p1_codec,
            bv_flags.clone(),
            vec![
                "-map".into(), "0:v".into(),
                "-an".into(),
                "-f".into(), "null".into(),
                null_device().to_string(),
            ],
        ]
        .concat();

        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&p1, eff_duration, cancel_flag.clone(), active_proc.clone(), move |f| {
                emit_progress(&app_c, &id, f * 0.5, None);
            })?;
        }

        // ── Pass 2 ──────────────────────────────────────────────────────────
        let p2: Vec<String> = [
            base_args,
            seek_args,
            vec!["-i".into(), input_file.to_string()],
            dur_args,
            p2_codec,
            bv_flags,
            audio_map,
            audio_encode,
            faststart,
            gif_args,
            vec![output_file.clone()],
        ]
        .concat();

        let start_time = Instant::now();
        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&p2, eff_duration, cancel_flag, active_proc, move |f| {
                let remaining = if f > 0.02 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    Some(elapsed / f * (1.0 - f))
                } else {
                    None
                };
                emit_progress(&app_c, &id, 0.5 + f * 0.5, remaining);
            })?;
        }

        // Clean up passlog files
        for suffix in ["-0.log", "-0.log.mbtree"] {
            let _ = fs::remove_file(format!("{}{}", passlog, suffix));
        }
    } else {
        // ── Single pass ──────────────────────────────────────────────────────
        let sc: Vec<String> = [
            base_args,
            seek_args,
            vec!["-i".into(), input_file.to_string()],
            dur_args,
            s_codec,
            bv_flags,
            audio_map,
            audio_encode,
            faststart,
            gif_args,
            vec![output_file.clone()],
        ]
        .concat();

        let start_time = Instant::now();
        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&sc, eff_duration, cancel_flag, active_proc, move |f| {
                let remaining = if f > 0.02 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    Some(elapsed / f * (1.0 - f))
                } else {
                    None
                };
                emit_progress(&app_c, &id, f, remaining);
            })?;
        }
    }

    Ok(output_file)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let temp_files = Arc::new(Mutex::new(HashSet::new()));
    cleanup_temp_files(&temp_files);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = supported_video_paths(argv.into_iter().skip(1));
            if paths.is_empty() {
                return;
            }
            focus_main_window(app);
            let path_bufs = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
            emit_native_dropped_paths(app, &path_bufs);
        }))
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            active_proc: Arc::new(Mutex::new(None)),
            launch_paths: Mutex::new(supported_video_paths(std::env::args().skip(1))),
            temp_files: temp_files.clone(),
        })
        .setup(move |_| {
            let temp_files = temp_files.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(TEMP_SWEEP_INTERVAL);
                cleanup_temp_files(&temp_files);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                emit_native_dropped_paths(&window.app_handle(), paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // FFmpeg
            check_ffmpeg,
            get_launch_paths,
            get_thumbnail,
            get_audio_tracks,
            // Video serving
            get_file_url,
            get_file_size,
            get_mixed_preview_url,
            delete_temp_file,
            // Settings
            save_settings,
            load_settings,
            // Compression
            compress,
            cancel_compression,
            // File & system ops
            open_file,
            open_in_media_player,
            open_url,
            rename_file,
            resolve_dropped_path,
            // Dialogs
            open_file_dialog,
            pick_directory,
            // Window controls
            window_minimize,
            window_toggle_maximize,
            window_close,
            set_window_fullscreen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hydraulic");
}
