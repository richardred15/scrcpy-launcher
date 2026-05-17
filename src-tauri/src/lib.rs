use base64::Engine as _;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex, OnceLock,
};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use ureq::config::Config;

static CHILDREN: LazyLock<Mutex<HashMap<String, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn kill_children() {
    let settings = fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_else(default_settings);
    let kill = settings.kill_on_close;
    let Ok(mut children) = CHILDREN.lock() else {
        eprintln!("[scrcpy-launcher] kill_children: lock failed");
        return;
    };
    eprintln!(
        "[scrcpy-launcher] kill_children: {} children, kill={}",
        children.len(),
        kill
    );
    if kill {
        for (_, child) in children.iter_mut() {
            let pid = child.id();
            eprintln!("[scrcpy-launcher] kill_children: killing pid={pid}");
            let _ = Command::new("pkill")
                .args(["-P", &pid.to_string()])
                .status();
            std::thread::sleep(Duration::from_millis(100));
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[scrcpy-launcher] kill_children: pid={pid} done");
        }
    } else {
        for (_, child) in children.drain() {
            std::mem::forget(child);
        }
    }
    children.clear();
    eprintln!("[scrcpy-launcher] kill_children: done");
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    adb_path: String,
    scrcpy_path: String,
    include_system_apps: bool,
    icon_source: IconSource,
    #[serde(default = "default_flex_display")]
    flex_display: bool,
    #[serde(default = "default_web_enabled")]
    web_enabled: bool,
    #[serde(default = "default_adb_fallback")]
    adb_fallback: bool,
    #[serde(default = "default_kill_on_close")]
    kill_on_close: bool,
    #[serde(default)]
    display_bounds: String,
    #[serde(default)]
    device_display_bounds: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum IconSource {
    Web,
    None,
}

fn default_flex_display() -> bool {
    true
}

fn default_web_enabled() -> bool {
    true
}

fn default_adb_fallback() -> bool {
    true
}

fn default_kill_on_close() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    adb: BinaryStatus,
    scrcpy: BinaryStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryStatus {
    path: String,
    found: bool,
    version: Option<String>,
    help: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    serial: String,
    state: String,
    model: Option<String>,
    android_version: Option<String>,
    battery_level: Option<u32>,
    battery_temperature: Option<f32>,
    battery_charging: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidApp {
    package_name: String,
    activity: Option<String>,
    label: String,
    icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAppMeta {
    label: String,
    icon_data_url: Option<String>,
    source: String,
    resolved_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMetaResolvedEvent {
    package_name: String,
    label: String,
    icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    used_flex_display: bool,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppsLoadedEvent {
    serial: String,
    apps: Vec<AndroidApp>,
}

fn default_settings() -> Settings {
    Settings {
        adb_path: "adb".into(),
        scrcpy_path: "scrcpy".into(),
        include_system_apps: false,
        icon_source: IconSource::None,
        flex_display: default_flex_display(),
        web_enabled: default_web_enabled(),
        adb_fallback: default_adb_fallback(),
        kill_on_close: default_kill_on_close(),
        display_bounds: "540x960".into(),
        device_display_bounds: HashMap::new(),
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to locate config directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create config directory: {err}"))?;
    dir.push("settings.json");
    Ok(dir)
}

fn read_settings(app: &tauri::AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return default_settings();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return default_settings();
    };
    serde_json::from_str(&contents).unwrap_or_else(|_| default_settings())
}

fn read_settings_from_file() -> Settings {
    let path = settings_file_path();
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_settings)
}

// ── Cache ────────────────────────────────────────────────────────────────────

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Unable to locate cache directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create cache directory: {err}"))?;
    dir.push("app_metadata_cache.json");
    Ok(dir)
}

fn read_metadata_cache(app: &tauri::AppHandle) -> HashMap<String, CachedAppMeta> {
    let Ok(path) = cache_path(app) else {
        return HashMap::new();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn write_metadata_cache(app: &tauri::AppHandle, cache: &HashMap<String, CachedAppMeta>) {
    if let Ok(path) = cache_path(app) {
        if let Ok(contents) = serde_json::to_string_pretty(cache) {
            let _ = fs::write(path, contents);
        }
    }
}

// ── Rate-limited web resolvers ──────────────────────────────────────────────

fn http_agent() -> ureq::Agent {
    let config = Config::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(20)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn fetch_body(url: &str) -> Result<String, String> {
    let agent = http_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("HTTP error: {e}"))?;
    resp.into_body()
        .read_to_string()
        .map_err(|e| format!("Read error: {e}"))
}

fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let agent = http_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("HTTP error: {e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    resp.into_body()
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("Read error: {e}"))?;
    Ok(buf)
}

fn download_icon_as_data_url(url: &str) -> Option<String> {
    let bytes = fetch_bytes(url).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let engine = base64::engine::general_purpose::STANDARD;
    // Sniff MIME from first bytes; fallback to URL extension
    let mime = if bytes.len() > 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    {
        "image/png"
    } else if bytes.len() > 4
        && bytes[..4] == [0x52, 0x49, 0x46, 0x46]
        && bytes.len() > 12
        && bytes[8..12] == [0x57, 0x45, 0x42, 0x50]
    {
        "image/webp"
    } else {
        "image/png"
    };
    Some(format!("data:{};base64,{}", mime, engine.encode(&bytes)))
}

fn rate_limit(last: &mut Instant, interval: Duration) {
    let elapsed = last.elapsed();
    if elapsed < interval {
        std::thread::sleep(interval - elapsed);
    }
    *last = Instant::now();
}

fn scrape_google_play(pkg: &str) -> Option<(String, String)> {
    let url = format!("https://play.google.com/store/apps/details?id={pkg}");
    eprintln!("  google: {url}");
    let body = fetch_body(&url).ok()?;
    let doc = Html::parse_document(&body);

    // Extract label from og:title meta tag
    let title_sel = Selector::parse("meta[property='og:title']").ok()?;
    let title = doc.select(&title_sel).next()?.value().attr("content")?;
    let label = if let Some(idx) = title.rfind(" - ") {
        title[..idx].to_string()
    } else {
        title.to_string()
    };
    if label.is_empty() {
        return None;
    }

    // Extract icon from og:image meta tag
    let og_image_sel = Selector::parse("meta[property='og:image']").ok()?;
    let icon_url = doc
        .select(&og_image_sel)
        .next()?
        .value()
        .attr("content")?
        .to_string();

    if icon_url.is_empty() {
        return None;
    }

    eprintln!("got label={label:?} icon={icon_url:?}");
    Some((label, icon_url))
}

fn scrape_fdroid(pkg: &str) -> Option<(String, String)> {
    let url = format!("https://f-droid.org/packages/{pkg}/");
    eprintln!("  fdroid: {url}");
    let body = fetch_body(&url).ok()?;
    let doc = Html::parse_document(&body);

    // Extract label from <title>
    let title_sel = Selector::parse("title").ok()?;
    let title = doc.select(&title_sel).next()?.inner_html();
    let label = if let Some(idx) = title.rfind(" | ") {
        title[..idx].to_string()
    } else {
        title
    };
    if label.is_empty() {
        return None;
    }

    // Extract icon from the package page image
    let icon_sel = Selector::parse("img.package-icon").ok()?;
    let icon_url = doc
        .select(&icon_sel)
        .next()?
        .value()
        .attr("src")?
        .to_string();
    let icon_url = if icon_url.starts_with('/') {
        format!("https://f-droid.org{icon_url}")
    } else {
        icon_url
    };

    eprintln!("got label={label:?} icon={icon_url:?}");
    Some((label, icon_url))
}

// ── ADB icon extraction ─────────────────────────────────────────────────────

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    let output = command
        .output()
        .map_err(|err| format!("Failed to run {program}: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            stderr
        })
    }
}

fn adb(settings: &Settings, serial: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut all_args = Vec::new();
    if let Some(serial) = serial {
        all_args.extend(["-s", serial]);
    }
    all_args.extend_from_slice(args);
    run_command(&settings.adb_path, &all_args)
}

fn adb_shell(settings: &Settings, serial: &str, args: &[&str]) -> Result<String, String> {
    let mut all_args = vec!["shell"];
    all_args.extend_from_slice(args);
    adb(settings, Some(serial), &all_args)
}

fn pretty_label(package_name: &str) -> String {
    let tail = package_name.rsplit('.').next().unwrap_or(package_name);
    let with_spaces = tail
        .chars()
        .fold(String::with_capacity(tail.len() + 5), |mut s, c| {
            if c.is_uppercase()
                && !s.is_empty()
                && s.chars().last().is_some_and(|p| p.is_lowercase())
            {
                s.push(' ');
            }
            s.push(c);
            s
        });
    with_spaces
        .split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_package_line(line: &str) -> Option<String> {
    line.strip_prefix("package:")
        .map(|value| value.rsplit('=').next().unwrap_or(value).trim().to_string())
}

fn parse_activity_line(line: &str) -> Option<(String, String)> {
    let clean = line.trim();
    if clean.is_empty()
        || clean.starts_with("activity:")
        || clean.starts_with("priority=")
        || clean.starts_with("No activities found")
    {
        return None;
    }
    let component = clean.split_whitespace().last()?;
    let (package_name, activity) = component.split_once('/')?;
    Some((package_name.to_string(), activity.to_string()))
}

fn scrcpy_supports_flex_display(settings: &Settings) -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        run_command(&settings.scrcpy_path, &["--help"])
            .map(|help| help.contains("--flex-display") || help.contains("-x, --flex-display"))
            .unwrap_or(false)
    })
}

fn scrcpy_supports_display_bounds(settings: &Settings) -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        run_command(&settings.scrcpy_path, &["--help"])
            .map(|help| help.contains("--display-bounds"))
            .unwrap_or(false)
    })
}

fn parse_battery_info(output: &str) -> (Option<u32>, Option<f32>, Option<bool>) {
    let mut level = None;
    let mut temperature = None;
    let mut charging = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("level: ") {
            level = rest.trim().parse::<u32>().ok();
        } else if let Some(rest) = trimmed.strip_prefix("temperature: ") {
            temperature = rest.trim().parse::<u32>().ok().map(|t| t as f32 / 10.0);
        } else if let Some(rest) = trimmed.strip_prefix("status: ") {
            charging = rest
                .trim()
                .parse::<u32>()
                .ok()
                .map(|s| s == 2 || s == 5);
        }
    }
    (level, temperature, charging)
}

// ── ADB icon extraction ─────────────────────────────────────────────────────

struct ParsedIconEntry {
    filename: String,
    compression_method: u16,
    compressed_size: u64,
    data_start: u64,
}

fn find_eocd_with_offset(tail: &[u8]) -> Option<(usize, u64, u64)> {
    for i in (0..tail.len().saturating_sub(22)).rev() {
        if &tail[i..i + 4] == b"PK\x05\x06" {
            let eocd = &tail[i..];
            let cd_offset = u64::from(u32::from_le_bytes(eocd[16..20].try_into().ok()?));
            let cd_size = u64::from(u32::from_le_bytes(eocd[12..16].try_into().ok()?));
            if cd_offset == 0xFFFFFFFF {
                return None;
            }
            return Some((i, cd_offset, cd_size));
        }
    }
    None
}

fn is_icon_filename(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.starts_with("res/")
        && lower.contains("ic_launcher")
        && (lower.ends_with(".png") || lower.ends_with(".webp"))
        && !lower.contains("_foreground")
        && !lower.contains("_background")
}

fn icon_score(filename: &str) -> i32 {
    let lower = filename.to_lowercase();
    let mut score = 100;
    if !lower.contains("_round") {
        score += 50;
    }
    if lower.contains("-xxxhdpi") {
        score += 500;
    } else if lower.contains("-xxhdpi") {
        score += 400;
    } else if lower.contains("-xhdpi") {
        score += 300;
    } else if lower.contains("-hdpi") {
        score += 200;
    } else if lower.contains("-mdpi") {
        score += 100;
    }
    if lower.ends_with(".png") {
        score += 20;
    }
    score
}

fn find_best_icon_entry(cd_data: &[u8]) -> Option<ParsedIconEntry> {
    let mut best: Option<ParsedIconEntry> = None;
    let mut best_score = -1;
    let mut pos = 0;
    while pos + 46 <= cd_data.len() {
        if &cd_data[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let compression = u16::from_le_bytes([cd_data[pos + 10], cd_data[pos + 11]]);
        if compression != 0 && compression != 8 {
            let name_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 28..pos + 30].try_into().ok()?,
            ));
            let extra_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 30..pos + 32].try_into().ok()?,
            ));
            let comment_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 32..pos + 34].try_into().ok()?,
            ));
            pos += 46 + name_len + extra_len + comment_len;
            continue;
        }
        let comp_size = u64::from(u32::from_le_bytes(
            cd_data[pos + 20..pos + 24].try_into().ok()?,
        ));
        let name_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 28..pos + 30].try_into().ok()?,
        ));
        let extra_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 30..pos + 32].try_into().ok()?,
        ));
        let comment_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 32..pos + 34].try_into().ok()?,
        ));
        let local_offset = u64::from(u32::from_le_bytes(
            cd_data[pos + 42..pos + 46].try_into().ok()?,
        ));
        if pos + 46 + name_len <= cd_data.len() {
            let filename = std::str::from_utf8(&cd_data[pos + 46..pos + 46 + name_len]).ok()?;
            if is_icon_filename(filename) {
                let score = icon_score(filename);
                if score > best_score {
                    let data_start = local_offset + 30 + name_len as u64 + extra_len as u64;
                    best = Some(ParsedIconEntry {
                        filename: filename.to_string(),
                        compression_method: compression,
                        compressed_size: comp_size,
                        data_start,
                    });
                    best_score = score;
                }
            }
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    best
}

fn extract_icon_adb(settings: &Settings, serial: &str, package_name: &str) -> Option<String> {
    eprintln!("[scrcpy-launcher] icon: extracting for {package_name}");

    let output = adb_shell(settings, serial, &["pm", "path", package_name]).ok()?;
    let apk_path = output.lines().next()?.strip_prefix("package:")?.trim();
    if apk_path.is_empty() {
        eprintln!("[scrcpy-launcher] icon: empty APK path for {package_name}");
        return None;
    }
    eprintln!("[scrcpy-launcher] icon: APK path = {apk_path}");

    let engine = base64::engine::general_purpose::STANDARD;

    // Phase 1: read last 64KB to find EOCD + CD size
    let cmd = format!("tail -c 65536 '{}' 2>/dev/null | base64", apk_path);
    let output = match adb_shell(settings, serial, &[&cmd]) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: tail -c failed: {e}");
            return None;
        }
    };
    let tail_b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
    let mut tail = match engine.decode(&tail_b64) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: base64 decode failed (tail): {e}");
            return None;
        }
    };
    eprintln!(
        "[scrcpy-launcher] icon: tail read {} bytes for {package_name}",
        tail.len()
    );

    let (eocd_buf_off, cd_offset, cd_size) = find_eocd_with_offset(&tail)?;
    eprintln!(
        "[scrcpy-launcher] icon: EOCD at buf offset {}, CD offset={}, size={}",
        eocd_buf_off, cd_offset, cd_size
    );

    // Phase 2: if CD doesn't fit in 64KB, re-read with enough bytes
    let total_needed = cd_size as usize + 22;
    let read_size = std::cmp::max(65536, total_needed);
    if read_size > 65536 {
        if read_size > 5_000_000 {
            eprintln!(
                "[scrcpy-launcher] icon: CD too large ({} MB) for {package_name}",
                read_size / 1_000_000
            );
            return None;
        }
        let cmd = format!("tail -c {} '{}' 2>/dev/null | base64", read_size, apk_path);
        let output = match adb_shell(settings, serial, &[&cmd]) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[scrcpy-launcher] icon: re-read failed: {e}");
                return None;
            }
        };
        let b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
        tail = engine.decode(&b64).ok()?;
        eprintln!(
            "[scrcpy-launcher] icon: re-read {} bytes for {package_name}",
            tail.len()
        );
    }

    // Re-find EOCD (needed if we re-read)
    let (eocd_buf_off, _cd_offset, cd_size) = find_eocd_with_offset(&tail)?;

    let cd_start: usize = if eocd_buf_off >= cd_size as usize {
        eocd_buf_off - cd_size as usize
    } else {
        eprintln!(
            "[scrcpy-launcher] icon: CD ({} bytes) still too large after re-read for {package_name}",
            cd_size
        );
        return None;
    };

    if cd_start >= tail.len() {
        eprintln!(
            "[scrcpy-launcher] icon: CD start out of bounds ({cd_start} >= {})",
            tail.len()
        );
        return None;
    }
    let cd_data = &tail[cd_start..];

    let icon_entry = match find_best_icon_entry(cd_data) {
        Some(e) => e,
        None => {
            eprintln!(
                "[scrcpy-launcher] icon: no launcher-icon entry found in CD for {package_name}"
            );
            return None;
        }
    };
    eprintln!(
        "[scrcpy-launcher] icon: found '{}' (compression={}, size={}, data_start={})",
        icon_entry.filename,
        icon_entry.compression_method,
        icon_entry.compressed_size,
        icon_entry.data_start
    );

    let cmd = format!(
        "dd if='{}' bs=1 skip={} count={} 2>/dev/null | base64",
        apk_path, icon_entry.data_start, icon_entry.compressed_size
    );
    let output = match adb_shell(settings, serial, &[&cmd]) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: dd icon read failed: {e}");
            return None;
        }
    };
    let compressed_b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
    let compressed = match engine.decode(&compressed_b64) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: base64 decode failed (icon data): {e}");
            return None;
        }
    };
    if compressed.len() as u64 != icon_entry.compressed_size {
        eprintln!(
            "[scrcpy-launcher] icon: size mismatch: read {} expected {}",
            compressed.len(),
            icon_entry.compressed_size
        );
        return None;
    }

    let icon_data = if icon_entry.compression_method == 0 {
        compressed
    } else if icon_entry.compression_method == 8 {
        use std::io::Read;
        let mut decoder = flate2::read::DeflateDecoder::new(&compressed[..]);
        let mut buf = Vec::with_capacity(icon_entry.compressed_size as usize * 4);
        if decoder.read_to_end(&mut buf).is_err() {
            eprintln!("[scrcpy-launcher] icon: deflate decompression failed for {package_name}");
            return None;
        }
        buf
    } else {
        eprintln!(
            "[scrcpy-launcher] icon: unsupported compression method {} for {package_name}",
            icon_entry.compression_method
        );
        return None;
    };

    let mime = if icon_entry.filename.ends_with(".png") {
        "image/png"
    } else if icon_entry.filename.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };

    eprintln!(
        "[scrcpy-launcher] icon: success for {package_name} ({} bytes {})",
        icon_data.len(),
        mime
    );
    Some(format!(
        "data:{};base64,{}",
        mime,
        engine.encode(&icon_data)
    ))
}

// ── Computed helpers (no AppHandle needed) ──────────────────────────────────

fn compute_tool_status(settings: &Settings) -> ToolStatus {
    let adb_version = run_command(&settings.adb_path, &["version"]).ok();
    let scrcpy_version = run_command(&settings.scrcpy_path, &["--version"]).ok();
    ToolStatus {
        adb: BinaryStatus {
            path: settings.adb_path.clone(),
            found: adb_version.is_some(),
            version: adb_version
                .as_deref()
                .and_then(|v| v.lines().next())
                .map(str::to_string),
            help: "Install Android platform-tools, then set the adb path here if it is not on PATH."
                .into(),
        },
        scrcpy: BinaryStatus {
            path: settings.scrcpy_path.clone(),
            found: scrcpy_version.is_some(),
            version: scrcpy_version
                .as_deref()
                .and_then(|v| v.lines().next())
                .map(str::to_string),
            help: "Install scrcpy from your package manager, Homebrew, Chocolatey, Scoop, or the upstream releases page."
                .into(),
        },
    }
}

fn compute_devices(settings: &Settings) -> Vec<Device> {
    let output = match adb(settings, None, &["devices"]) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut devices = Vec::new();
    for line in output.lines().skip(1) {
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };
        let state = parts.next().unwrap_or("unknown").to_string();
        if state != "device" {
            devices.push(Device {
                serial: serial.into(),
                state,
                model: None,
                android_version: None,
                battery_level: None,
                battery_temperature: None,
                battery_charging: None,
            });
            continue;
        }
        let model = adb_shell(settings, serial, &["getprop", "ro.product.model"]).ok();
        let android_version =
            adb_shell(settings, serial, &["getprop", "ro.build.version.release"]).ok();
        let battery = adb_shell(settings, serial, &["dumpsys", "battery"]).ok();
        let (battery_level, battery_temperature, battery_charging) = battery
            .as_deref()
            .map(parse_battery_info)
            .unwrap_or_default();
        devices.push(Device {
            serial: serial.into(),
            state,
            model: model.filter(|v| !v.is_empty()),
            android_version: android_version.filter(|v| !v.is_empty()),
            battery_level,
            battery_temperature,
            battery_charging,
        });
    }
    devices
}

fn compute_apps(settings: &Settings, serial: &str) -> Vec<AndroidApp> {
    let mut apps_map: HashMap<String, AndroidApp> = HashMap::new();

    if let Ok(output) = adb_shell(
        settings,
        serial,
        &[
            "cmd",
            "package",
            "query-activities",
            "--brief",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
        ],
    ) {
        for line in output.lines() {
            if let Some((package_name, activity)) = parse_activity_line(line) {
                apps_map.entry(package_name.clone()).or_insert(AndroidApp {
                    label: pretty_label(&package_name),
                    package_name,
                    activity: Some(activity),
                    icon_url: None,
                });
            }
        }
    }

    if apps_map.is_empty() {
        let package_args = if settings.include_system_apps {
            vec!["pm", "list", "packages"]
        } else {
            vec!["pm", "list", "packages", "-3"]
        };
        if let Ok(output) = adb_shell(settings, serial, &package_args) {
            for line in output.lines() {
                if let Some(package_name) = parse_package_line(line) {
                    apps_map.entry(package_name.clone()).or_insert(AndroidApp {
                        label: pretty_label(&package_name),
                        package_name,
                        activity: None,
                        icon_url: None,
                    });
                }
            }
        }
    }

    let mut app_list: Vec<_> = apps_map.into_values().collect();
    app_list.sort_by_key(|a| a.label.to_lowercase());
    app_list
}

// ── Background worker loop ──────────────────────────────────────────────────

struct RefreshFlag(Arc<AtomicBool>);

fn worker_loop(app_handle: tauri::AppHandle, flag: Arc<AtomicBool>, exit: Arc<AtomicBool>) {
    loop {
        if exit.load(Ordering::Relaxed) {
            return;
        }

        let settings = read_settings_from_file();

        let tools = compute_tool_status(&settings);
        let _ = app_handle.emit("tool-status-updated", &tools);

        let devices = compute_devices(&settings);
        let _ = app_handle.emit("devices-updated", &devices);

        // Sleep 10 s with early wake on refresh signal or exit
        for _ in 0..100 {
            if exit.load(Ordering::Relaxed) {
                return;
            }
            if flag.swap(false, Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

// ── Trigger commands (lightweight, dispatch to background threads) ──────────

#[tauri::command]
fn trigger_refresh(flag: tauri::State<RefreshFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn trigger_load_apps(app_handle: tauri::AppHandle, serial: String) {
    std::thread::spawn(move || {
        let settings = read_settings_from_file();
        let apps = compute_apps(&settings, &serial);
        let _ = app_handle.emit("apps-loaded", AppsLoadedEvent { serial, apps });
    });
}

// ── Sync commands (fast file I/O, no external tools) ────────────────────────

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("Unable to serialize settings: {err}"))?;
    fs::write(path, contents).map_err(|err| format!("Unable to save settings: {err}"))?;
    Ok(settings)
}

#[tauri::command]
fn get_cached_app_meta(app: tauri::AppHandle) -> HashMap<String, CachedAppMeta> {
    read_metadata_cache(&app)
}

#[tauri::command]
fn resolve_app_batch(
    app_handle: tauri::AppHandle,
    serial: String,
    pkgs: Vec<String>,
) -> Result<(), String> {
    let settings = read_settings(&app_handle);
    let mut cache = read_metadata_cache(&app_handle);

    std::thread::spawn(move || {
        let mut google_last = Instant::now() - Duration::from_secs(3);
        let mut fdroid_last = Instant::now() - Duration::from_secs(3);

        for pkg in &pkgs {
            if let Some(meta) = cache.get(pkg) {
                let _ = app_handle.emit(
                    "app-meta-resolved",
                    AppMetaResolvedEvent {
                        package_name: pkg.clone(),
                        label: meta.label.clone(),
                        icon_url: meta.icon_data_url.clone(),
                    },
                );
                continue;
            }

            eprintln!("[scrcpy-launcher] resolve: {pkg}");

            if settings.web_enabled {
                rate_limit(&mut google_last, Duration::from_secs(2));
                if let Some((label, icon_url)) = scrape_google_play(pkg) {
                    let icon_data_url = download_icon_as_data_url(&icon_url);
                    let meta = CachedAppMeta {
                        label: label.clone(),
                        icon_data_url: icon_data_url.clone(),
                        source: "google_play".into(),
                        resolved_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    cache.insert(pkg.clone(), meta);
                    write_metadata_cache(&app_handle, &cache);
                    let _ = app_handle.emit(
                        "app-meta-resolved",
                        AppMetaResolvedEvent {
                            package_name: pkg.clone(),
                            label,
                            icon_url: icon_data_url,
                        },
                    );
                    continue;
                }
            }

            if settings.web_enabled {
                rate_limit(&mut fdroid_last, Duration::from_secs(2));
                if let Some((label, icon_url)) = scrape_fdroid(pkg) {
                    let icon_data_url = download_icon_as_data_url(&icon_url);
                    let meta = CachedAppMeta {
                        label: label.clone(),
                        icon_data_url: icon_data_url.clone(),
                        source: "fdroid".into(),
                        resolved_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    cache.insert(pkg.clone(), meta);
                    write_metadata_cache(&app_handle, &cache);
                    let _ = app_handle.emit(
                        "app-meta-resolved",
                        AppMetaResolvedEvent {
                            package_name: pkg.clone(),
                            label,
                            icon_url: icon_data_url,
                        },
                    );
                    continue;
                }
            }

            if settings.adb_fallback {
                let icon = extract_icon_adb(&settings, &serial, pkg);
                let label = pretty_label(pkg);
                let meta = CachedAppMeta {
                    label: label.clone(),
                    icon_data_url: icon.clone(),
                    source: "adb".into(),
                    resolved_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                cache.insert(pkg.clone(), meta);
                write_metadata_cache(&app_handle, &cache);
                let _ = app_handle.emit(
                    "app-meta-resolved",
                    AppMetaResolvedEvent {
                        package_name: pkg.clone(),
                        label,
                        icon_url: icon,
                    },
                );
            }
        }

        let _ = app_handle.emit("app-meta-batch-complete", ());
    });

    Ok(())
}

#[tauri::command]
fn prune_cache(app: tauri::AppHandle, pkgs: Vec<String>) -> Result<(), String> {
    let mut cache = read_metadata_cache(&app);
    cache.retain(|k, _| pkgs.contains(k));
    write_metadata_cache(&app, &cache);
    Ok(())
}

static KDOTOOL_PATH: OnceLock<String> = OnceLock::new();

fn kdotool_path() -> &'static str {
    KDOTOOL_PATH.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            "kdotool",
            &format!("{home}/.cargo/bin/kdotool"),
            "/usr/bin/kdotool",
            "/usr/local/bin/kdotool",
        ];
        for c in &candidates {
            if std::path::Path::new(c).is_file() {
                return c.to_string();
            }
        }
        "kdotool".to_string()
    })
}

fn focus_window(pid: u32) -> bool {
    // kdotool (KDE Wayland focus via KWin scripting API)
    let status = Command::new(kdotool_path())
        .args(["search", "--pid", &pid.to_string(), "windowactivate"])
        .status();
    if let Ok(s) = status {
        if s.success() {
            return true;
        }
    }

    // Fallback: xdotool (X11 / XWayland)
    Command::new("xdotool")
        .args(["search", "--pid", &pid.to_string(), "windowactivate"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
fn launch_mirror(app: tauri::AppHandle, serial: String) -> Result<LaunchResult, String> {
    let key = format!("__mirror__:{serial}");
    let settings = read_settings(&app);
    let window_title = format!("scrcpy-launcher:mirror:{serial}");
    eprintln!("launch_mirror: serial={} title={}", serial, window_title);

    let maybe_child = {
        let mut map = CHILDREN.lock().unwrap();
        map.remove(&key)
    };
    if let Some(mut child) = maybe_child {
        match child.try_wait() {
            Ok(None) => {
                let pid = child.id();
                CHILDREN.lock().unwrap().insert(key, child);
                std::thread::spawn(move || focus_window(pid));
                return Ok(LaunchResult {
                    used_flex_display: false,
                    message: None,
                });
            }
            _ => {}
        }
    }

    let display_bounds = settings
        .device_display_bounds
        .get(&serial)
        .map(String::as_str)
        .or(if settings.display_bounds.is_empty() {
            None
        } else {
            Some(settings.display_bounds.as_str())
        });
    let supports_bounds = !display_bounds.is_none() && scrcpy_supports_display_bounds(&settings);

    let mut args = vec![
        "-s".to_string(),
        serial,
        "--window-title".to_string(),
        window_title,
    ];

    if let Some(bounds) = display_bounds {
        if supports_bounds {
            args.push("--display-bounds".to_string());
            args.push(bounds.to_string());
        }
    }

    let child = Command::new(&settings.scrcpy_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn();
    match child {
        Ok(child) => {
            eprintln!("launch_mirror: scrcpy spawned OK pid={}", child.id());
            CHILDREN.lock().unwrap().insert(key, child);
            Ok(LaunchResult {
                used_flex_display: false,
                message: None,
            })
        }
        Err(err) => {
            eprintln!("launch_mirror: scrcpy spawn FAILED: {}", err);
            Err(format!("Failed to launch scrcpy: {err}"))
        }
    }
}

#[tauri::command]
fn launch_app(
    app: tauri::AppHandle,
    serial: String,
    package_name: String,
    _label: String,
) -> Result<LaunchResult, String> {
    let settings = read_settings(&app);
    let window_title = format!("scrcpy-launcher:{package_name}:{serial}");
    eprintln!(
        "launch_app: pkg={} serial={} title={}",
        package_name, serial, window_title
    );

    let maybe_child = {
        let mut map = CHILDREN.lock().unwrap();
        let size = map.len();
        eprintln!("launch_app: tracker size={}", size);
        map.remove(&package_name)
    };
    if let Some(mut child) = maybe_child {
        eprintln!("launch_app: child found in tracker");
        match child.try_wait() {
            Ok(None) => {
                let pid = child.id();
                CHILDREN.lock().unwrap().insert(package_name, child);
                eprintln!("launch_app: child alive pid={}, focussing window", pid);
                std::thread::spawn(move || {
                    focus_window(pid);
                });
                return Ok(LaunchResult {
                    used_flex_display: false,
                    message: None,
                });
            }
            _ => {
                eprintln!("launch_app: child exited, launching new");
            }
        }
    } else {
        eprintln!("launch_app: child NOT found in tracker");
    }

    let supports_flex = settings.flex_display && scrcpy_supports_flex_display(&settings);
    let display_bounds = settings
        .device_display_bounds
        .get(&serial)
        .map(String::as_str)
        .or(if settings.display_bounds.is_empty() {
            None
        } else {
            Some(settings.display_bounds.as_str())
        });
    let supports_bounds = display_bounds.is_some() && scrcpy_supports_display_bounds(&settings);
    eprintln!(
        "launch_app: launching new scrcpy, flex={} bounds={:?}",
        supports_flex, display_bounds
    );
    let mut args = vec![
        "-s".to_string(),
        serial,
        "--new-display".to_string(),
        "--start-app".to_string(),
        format!("+{package_name}"),
        "--window-title".to_string(),
        window_title,
        "--display-ime-policy=local".to_string(),
        "--no-audio".to_string(),
    ];

    if supports_flex {
        args.push("--flex-display".to_string());
    }

    if let Some(bounds) = display_bounds {
        if supports_bounds {
            args.push("--display-bounds".to_string());
            args.push(bounds.to_string());
        }
    }

    let child = Command::new(&settings.scrcpy_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(child) => {
            eprintln!("launch_app: scrcpy spawned OK");
            CHILDREN.lock().unwrap().insert(package_name, child);
            Ok(LaunchResult {
                used_flex_display: supports_flex,
                message: None,
            })
        }
        Err(err) => {
            eprintln!("launch_app: scrcpy spawn FAILED: {}", err);
            Err(format!("Failed to launch scrcpy: {err}"))
        }
    }
}

/// Returns the settings path without needing an AppHandle (used during cleanup).
fn settings_file_path() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            PathBuf::from(home).join(".config")
        });
    base.join("scrcpy-launcher").join("settings.json")
}

/// Restores the terminal to a saved state when dropped.
struct TerminalGuard(Option<String>);

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if let Some(ref s) = self.0 {
            let _ = Command::new("stty").args([s.as_str()]).status();
        }
    }
}

pub fn run() {
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    let saved = Command::new("stty")
        .arg("-g")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());

    let _guard = TerminalGuard(saved.clone());

    // Also restore terminal on panic so Ctrl+C / crashes don't leave it broken
    let hook_saved = saved.clone();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(ref s) = hook_saved {
            let _ = Command::new("stty").args([s.as_str()]).status();
        }
        prev(info);
    }));

    let exit_flag = Arc::new(AtomicBool::new(false));
    let worker_exit = exit_flag.clone();
    let worker_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let setup_handle = worker_handle.clone();

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            launch_app,
            launch_mirror,
            get_cached_app_meta,
            resolve_app_batch,
            prune_cache,
            trigger_refresh,
            trigger_load_apps,
        ])
        .setup(move |a| {
            let app_handle = a.handle().clone();
            let flag = Arc::new(AtomicBool::new(false));
            a.manage(RefreshFlag(flag.clone()));
            let h = std::thread::spawn(move || worker_loop(app_handle, flag, worker_exit));
            *setup_handle.lock().unwrap() = Some(h);
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("[scrcpy-launcher] build error: {e}");
            std::process::exit(1);
        });

    app.run(|_handle, event| match event {
        tauri::RunEvent::Exit
        | tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            kill_children();
        }
        _ => {}
    });

    // --- cleanup ---

    eprintln!("[scrcpy-launcher] signaling worker to stop");
    exit_flag.store(true, Ordering::Relaxed);

    if let Some(handle) = worker_handle.lock().unwrap().take() {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if handle.is_finished() {
            let _ = handle.join();
            eprintln!("[scrcpy-launcher] worker joined");
        } else {
            eprintln!("[scrcpy-launcher] worker did not stop in time");
        }
    }

    eprintln!("[scrcpy-launcher] exit complete");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pretty_label_simple() {
        assert_eq!(pretty_label("com.example.myapp"), "Myapp");
    }

    #[test]
    fn test_pretty_label_camel_case() {
        assert_eq!(pretty_label("com.example.myApp"), "My App");
    }

    #[test]
    fn test_pretty_label_underscore() {
        assert_eq!(pretty_label("com.example.my_app"), "My App");
    }

    #[test]
    fn test_pretty_label_hyphen() {
        assert_eq!(pretty_label("com.example.my-app"), "My App");
    }

    #[test]
    fn test_pretty_label_complex() {
        assert_eq!(pretty_label("com.android.vending"), "Vending");
    }

    #[test]
    fn test_pretty_label_single_word() {
        assert_eq!(pretty_label("simple"), "Simple");
    }

    #[test]
    fn test_parse_package_line_simple() {
        assert_eq!(
            parse_package_line("package:com.example.app"),
            Some("com.example.app".into())
        );
    }

    #[test]
    fn test_parse_package_line_no_match() {
        assert_eq!(parse_package_line("some other line"), None);
    }

    #[test]
    fn test_parse_package_line_with_equals() {
        // rsplit('=').next() returns the last segment (the version number)
        assert_eq!(
            parse_package_line("package:com.example.app=123"),
            Some("123".into())
        );
    }

    #[test]
    fn test_parse_activity_line_valid() {
        let result = parse_activity_line("  com.example.app/.MainActivity");
        assert_eq!(
            result,
            Some(("com.example.app".into(), ".MainActivity".into()))
        );
    }

    #[test]
    fn test_parse_activity_line_activity_prefix() {
        // query-activities --brief does not produce "activity=" lines;
        // if encountered, they're section headers that happen to parse as valid.
        let result = parse_activity_line("activity=com.example.app/.Main");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "activity=com.example.app");
    }

    #[test]
    fn test_parse_activity_line_priority() {
        assert_eq!(parse_activity_line("priority=1"), None);
    }

    #[test]
    fn test_parse_activity_line_no_activities() {
        assert_eq!(parse_activity_line("No activities found"), None);
    }

    #[test]
    fn test_parse_activity_line_empty() {
        assert_eq!(parse_activity_line(""), None);
    }

    #[test]
    fn test_parse_activity_line_whitespace() {
        assert_eq!(parse_activity_line("   "), None);
    }

    #[test]
    fn test_is_icon_filename_valid_png() {
        assert!(is_icon_filename("res/mipmap-hdpi/ic_launcher.png"));
    }

    #[test]
    fn test_is_icon_filename_valid_webp() {
        assert!(is_icon_filename("res/mipmap-hdpi/ic_launcher.webp"));
    }

    #[test]
    fn test_is_icon_filename_foreground() {
        assert!(!is_icon_filename(
            "res/mipmap-hdpi/ic_launcher_foreground.png"
        ));
    }

    #[test]
    fn test_is_icon_filename_background() {
        assert!(!is_icon_filename(
            "res/mipmap-hdpi/ic_launcher_background.png"
        ));
    }

    #[test]
    fn test_is_icon_filename_not_in_res() {
        assert!(!is_icon_filename("assets/ic_launcher.png"));
    }

    #[test]
    fn test_is_icon_filename_not_launcher() {
        assert!(!is_icon_filename("res/drawable/other.png"));
    }

    #[test]
    fn test_icon_score_prefers_non_round() {
        let round = icon_score("res/mipmap-xxhdpi/ic_launcher_round.png");
        let normal = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        assert!(normal > round);
    }

    #[test]
    fn test_icon_score_prefers_higher_density() {
        let mdpi = icon_score("res/mipmap-mdpi/ic_launcher.png");
        let xxhdpi = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        assert!(xxhdpi > mdpi);
    }

    #[test]
    fn test_icon_score_prefers_png_over_webp() {
        let png = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        let webp = icon_score("res/mipmap-xxhdpi/ic_launcher.webp");
        assert!(png > webp);
    }

    #[test]
    fn test_default_settings_values() {
        let s = default_settings();
        assert_eq!(s.adb_path, "adb");
        assert_eq!(s.scrcpy_path, "scrcpy");
        assert!(!s.include_system_apps);
        assert!(s.flex_display);
        assert!(s.web_enabled);
        assert!(s.adb_fallback);
        assert!(s.kill_on_close);
        assert_eq!(s.display_bounds, "540x960");
        assert!(s.device_display_bounds.is_empty());
    }

    #[test]
    fn test_default_functions() {
        assert!(default_flex_display());
        assert!(default_web_enabled());
        assert!(default_adb_fallback());
        assert!(default_kill_on_close());
    }

    #[test]
    fn test_find_eocd_with_offset_found() {
        // Build a fake ZIP tail with valid EOCD
        let mut buf = vec![0u8; 100];
        let cd_offset: u32 = 42;
        let cd_size: u32 = 128;
        // Write EOCD at offset 50
        buf[50..54].copy_from_slice(b"PK\x05\x06");
        // EOCD bytes 12..15 = cd_size, 16..19 = cd_offset
        buf[62..66].copy_from_slice(&cd_size.to_le_bytes());
        buf[66..70].copy_from_slice(&cd_offset.to_le_bytes());
        let tail = &buf[30..]; // give 30 bytes of prepad
        let result = find_eocd_with_offset(tail);
        assert!(result.is_some());
        let (buf_off, eocd_cd_off, eocd_cd_size) = result.unwrap();
        assert_eq!(buf_off, 20); // 50 - 30
        assert_eq!(eocd_cd_off, cd_offset as u64);
        assert_eq!(eocd_cd_size, cd_size as u64);
    }

    #[test]
    fn test_find_eocd_with_offset_not_found() {
        assert!(find_eocd_with_offset(b"no PK signature here").is_none());
    }

    #[test]
    fn test_find_eocd_with_offset_empty() {
        assert!(find_eocd_with_offset(b"").is_none());
    }

    #[test]
    fn test_parse_battery_info_full() {
        let (lvl, temp, chg) = parse_battery_info("  level: 85\n  temperature: 350\n  status: 2\n");
        assert_eq!(lvl, Some(85));
        assert_eq!(temp, Some(35.0));
        assert_eq!(chg, Some(true));
    }

    #[test]
    fn test_parse_battery_info_discharging() {
        let (lvl, temp, chg) = parse_battery_info("  level: 42\n  temperature: 310\n  status: 3\n");
        assert_eq!(lvl, Some(42));
        assert_eq!(temp, Some(31.0));
        assert_eq!(chg, Some(false));
    }

    #[test]
    fn test_parse_battery_info_full_status() {
        let (_, _, chg) = parse_battery_info("  status: 5\n");
        assert_eq!(chg, Some(true));
    }

    #[test]
    fn test_parse_battery_info_not_found() {
        let (lvl, temp, chg) = parse_battery_info("  voltage: 4348\n  technology: Li-ion\n");
        assert_eq!(lvl, None);
        assert_eq!(temp, None);
        assert_eq!(chg, None);
    }

    #[test]
    fn test_parse_battery_info_empty() {
        let (lvl, temp, chg) = parse_battery_info("");
        assert_eq!(lvl, None);
        assert_eq!(temp, None);
        assert_eq!(chg, None);
    }
}
