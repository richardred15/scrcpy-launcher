use std::collections::HashMap;
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Emitter;

use crate::adb::{
    adb_shell, no_window_command, scrcpy_supports_display_bounds, scrcpy_supports_flex_display,
};
use crate::cache::{self, CacheAction};
use crate::icon::extract_icon_adb;
use crate::platform::{app_desktop_write, focus_window, save_app_icon, scrcpy_app_id, scrcpy_dir};
use crate::runtime::{ACTIVE_APP_IDS, CHILDREN};
use crate::settings::read_settings;
use crate::types::{AppMetaResolvedEvent, CachedAppMeta, Folder, LaunchResult, Settings};
use crate::web::{download_icon_as_data_url, rate_limit, scrape_fdroid, scrape_google_play};

/// Split a shell-like argument string respecting single and double quotes.
/// e.g. `--window-title "My Device"` → `["--window-title", "My Device"]`
fn split_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for ch in s.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    args.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn stable_folder_id(settings: &Settings, serial: &str) -> String {
    adb_shell(settings, serial, &["getprop", "ro.serialno"])
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| serial.to_string())
}

// ── Folder Management ───────────────────────────────────────────────────────

#[tauri::command]
pub fn create_folder(
    app: tauri::AppHandle,
    serial: String,
    name: String,
) -> Result<String, String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let id = uuid::Uuid::new_v4().to_string();
    let folder = Folder {
        id: id.clone(),
        name,
        apps: Vec::new(),
    };
    let mut new_settings = settings.clone();
    new_settings
        .folders
        .entry(sid)
        .or_default()
        .insert(id.clone(), folder);
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(id)
}

#[tauri::command]
pub fn add_app_to_folder(
    app: tauri::AppHandle,
    serial: String,
    folder_id: String,
    package_name: String,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let mut new_settings = settings.clone();
    let device_folders = new_settings.folders.entry(sid).or_default();
    if !device_folders.contains_key(&folder_id) {
        if folder_id == "favorites" {
            device_folders.insert(
                folder_id.clone(),
                Folder {
                    id: folder_id.clone(),
                    name: "Favorites".into(),
                    apps: Vec::new(),
                },
            );
        } else {
            return Err("Folder not found".into());
        }
    }
    if let Some(folder) = device_folders.get_mut(&folder_id) {
        if !folder.apps.contains(&package_name) {
            folder.apps.push(package_name);
        }
    }
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn remove_app_from_folder(
    app: tauri::AppHandle,
    serial: String,
    folder_id: String,
    package_name: String,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let mut new_settings = settings.clone();
    if let Some(device_folders) = new_settings.folders.get_mut(&sid) {
        if let Some(folder) = device_folders.get_mut(&folder_id) {
            folder.apps.retain(|p| p != &package_name);
        } else {
            return Err("Folder not found".into());
        }
    } else {
        return Err("Folder not found".into());
    }
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn rename_folder(
    app: tauri::AppHandle,
    serial: String,
    folder_id: String,
    new_name: String,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let mut new_settings = settings.clone();
    if let Some(device_folders) = new_settings.folders.get_mut(&sid) {
        if let Some(folder) = device_folders.get_mut(&folder_id) {
            folder.name = new_name;
        } else {
            return Err("Folder not found".into());
        }
    } else {
        return Err("Folder not found".into());
    }
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_folder(
    app: tauri::AppHandle,
    serial: String,
    folder_id: String,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let mut new_settings = settings.clone();
    if let Some(device_folders) = new_settings.folders.get_mut(&sid) {
        if device_folders.remove(&folder_id).is_none() {
            return Err("Folder not found".into());
        }
    } else {
        return Err("Folder not found".into());
    }
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

// ── Settings commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn adb_install(app: tauri::AppHandle, serial: String, path: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let settings = read_settings(&app);
        let result = crate::adb::run_command_timeout(
            &settings.adb_path,
            &["-s", &serial, "install", &path],
            Duration::from_secs(120),
        );
        let (success, message) = match result {
            Ok(out) => (true, out),
            Err(e) => (false, e),
        };
        let _ = app.emit("apk-install-result", serde_json::json!({ "success": success, "message": message }));
    });
    Ok(())
}

#[tauri::command]
pub fn adb_pair(app: tauri::AppHandle, host_port: String, pairing_code: String) -> Result<String, String> {
    let settings = read_settings(&app);
    crate::adb::run_command_timeout(
        &settings.adb_path,
        &["pair", &host_port, &pairing_code],
        Duration::from_secs(30),
    )
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let path = crate::settings::settings_path(&app)?;
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("Unable to serialize settings: {err}"))?;
    fs::write(path, contents).map_err(|err| format!("Unable to save settings: {err}"))?;
    Ok(settings)
}

#[tauri::command]
pub fn set_scrcpy_args(app: tauri::AppHandle, serial: String, args: String) -> Result<(), String> {
    let settings = read_settings(&app);
    let sid = stable_folder_id(&settings, &serial);
    let mut new_settings = settings.clone();
    new_settings.device_scrcpy_args.insert(sid, args);
    let path = crate::settings::settings_path(&app)?;
    let contents = serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn set_app_scrcpy_args(app: tauri::AppHandle, package_name: String, args: String) -> Result<(), String> {
    let settings = read_settings(&app);
    let mut new_settings = settings.clone();
    new_settings.app_scrcpy_args.insert(package_name, args);
    let path = crate::settings::settings_path(&app)?;
    let contents = serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn install_scrcpy_windows(app: tauri::AppHandle) -> Result<Settings, String> {
    if !crate::platform::is_scrcpy_downloaded() {
        crate::platform::download_scrcpy()?;
    }
    let scrcpy_exe = scrcpy_dir().join("scrcpy.exe");
    let adb_exe = scrcpy_dir().join("adb.exe");
    let mut settings = read_settings(&app);
    settings.scrcpy_path = scrcpy_exe.to_string_lossy().to_string();
    settings.adb_path = adb_exe.to_string_lossy().to_string();
    let path = crate::settings::settings_path(&app)?;
    let contents =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Save error: {e}"))?;
    Ok(settings)
}

#[tauri::command]
pub fn get_cached_app_meta() -> HashMap<String, CachedAppMeta> {
    cache::snapshot()
}

// ── Resolve batch ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn resolve_app_batch(
    app_handle: tauri::AppHandle,
    serial: String,
    pkgs: Vec<String>,
) -> Result<(), String> {
    let settings = read_settings(&app_handle);

    if pkgs.is_empty() {
        return Ok(());
    }

    std::thread::spawn(move || {
        const MAX_CONCURRENT: usize = 4;
        let num_workers = std::cmp::min(MAX_CONCURRENT, pkgs.len());
        let mut handles = Vec::with_capacity(num_workers);

        for worker_id in 0..num_workers {
            let app_handle = app_handle.clone();
            let settings = settings.clone();
            let serial = serial.clone();
            let pkgs = pkgs.clone();

            handles.push(std::thread::spawn(move || {
                let mut google_last = Instant::now() - Duration::from_secs(3);
                let mut fdroid_last = Instant::now() - Duration::from_secs(3);
                let delay = Duration::from_millis(1000);

                let mut idx = worker_id;
                while idx < pkgs.len() {
                    let pkg = &pkgs[idx];

                    match cache::request(pkg) {
                        CacheAction::Cached(meta) => {
                            let _ = app_handle.emit(
                                "app-meta-resolved",
                                AppMetaResolvedEvent {
                                    package_name: pkg.clone(),
                                    label: meta.label.clone(),
                                    icon_url: meta.icon_data_url.clone(),
                                },
                            );
                            idx += num_workers;
                            continue;
                        }
                        CacheAction::Pending(rx) => {
                            if let Ok(meta) = rx.recv_timeout(Duration::from_secs(60)) {
                                let _ = app_handle.emit(
                                    "app-meta-resolved",
                                    AppMetaResolvedEvent {
                                        package_name: pkg.clone(),
                                        label: meta.label,
                                        icon_url: meta.icon_data_url,
                                    },
                                );
                            }
                            idx += num_workers;
                            continue;
                        }
                        CacheAction::Resolve => {}
                    }

                    eprintln!(
                        "[scrcpy-launcher] resolve: {pkg} (worker {worker_id}/{num_workers})"
                    );
                    let mut resolved = false;

                    if settings.web_enabled {
                        rate_limit(&mut google_last, delay);
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
                            cache::store(pkg.clone(), meta.clone());
                            let _ = app_handle.emit(
                                "app-meta-resolved",
                                AppMetaResolvedEvent {
                                    package_name: pkg.clone(),
                                    label,
                                    icon_url: icon_data_url,
                                },
                            );
                            resolved = true;
                        }
                    }

                    if !resolved && settings.web_enabled {
                        rate_limit(&mut fdroid_last, delay);
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
                            cache::store(pkg.clone(), meta.clone());
                            let _ = app_handle.emit(
                                "app-meta-resolved",
                                AppMetaResolvedEvent {
                                    package_name: pkg.clone(),
                                    label,
                                    icon_url: icon_data_url,
                                },
                            );
                            resolved = true;
                        }
                    }

                    if !resolved && settings.adb_fallback {
                        let icon = extract_icon_adb(&settings, &serial, pkg);
                        let label = crate::adb::pretty_label(pkg);
                        let meta = CachedAppMeta {
                            label: label.clone(),
                            icon_data_url: icon.clone(),
                            source: "adb".into(),
                            resolved_at: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                        };
                        cache::store(pkg.clone(), meta.clone());
                        let _ = app_handle.emit(
                            "app-meta-resolved",
                            AppMetaResolvedEvent {
                                package_name: pkg.clone(),
                                label,
                                icon_url: icon,
                            },
                        );
                    }

                    idx += num_workers;
                }
            }));
        }

        for handle in handles {
            if let Err(e) = handle.join() {
                eprintln!("[scrcpy-launcher] resolve worker panicked: {e:?}");
            }
        }

        cache::flush();
        let _ = app_handle.emit("app-meta-batch-complete", ());
    });

    Ok(())
}

// ── Notifications ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_notification_counts(app: tauri::AppHandle, serial: String) -> HashMap<String, u32> {
    let settings = read_settings(&app);
    let mut counts = HashMap::new();
    // `dumpsys notification --noredact` lists one `NotificationRecord` per notification.
    // Each record starts with a line like "  NotificationRecord(... pkg=com.example ...)".
    // Counting only those header lines gives one count per real notification.
    if let Ok(output) = crate::adb::adb_shell_timeout(
        &settings,
        &serial,
        &["dumpsys", "notification", "--noredact"],
        Duration::from_secs(8),
    ) {
        for line in output.lines() {
            if line.trim_start().starts_with("NotificationRecord(") {
                if let Some(rest) = line.split("pkg=").nth(1) {
                    let pkg = rest.split_whitespace().next().unwrap_or("").to_string();
                    if !pkg.is_empty() {
                        *counts.entry(pkg).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    counts
}

// ── ADB commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn adb_connect(app: tauri::AppHandle, host_port: String) -> Result<String, String> {
    let settings = read_settings(&app);
    eprintln!("adb_connect: {}", host_port);
    let output = no_window_command(&settings.adb_path)
        .args(["connect", &host_port])
        .output()
        .map_err(|e| format!("Failed to run adb: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        eprintln!("adb_connect: OK: {}", stdout);
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("adb_connect: FAILED: {}", stderr);
        Err(format!("ADB connect failed: {stderr}"))
    }
}

#[tauri::command]
pub fn adb_restart_server(app: tauri::AppHandle) -> Result<String, String> {
    let settings = read_settings(&app);
    eprintln!("adb_restart_server");
    let kill = no_window_command(&settings.adb_path)
        .arg("kill-server")
        .output()
        .map_err(|e| format!("Failed to run adb kill-server: {e}"))?;
    if !kill.status.success() {
        let stderr = String::from_utf8_lossy(&kill.stderr);
        eprintln!("adb kill-server FAILED: {}", stderr);
        return Err(format!("ADB kill-server failed: {stderr}"));
    }
    let start = no_window_command(&settings.adb_path)
        .arg("start-server")
        .output()
        .map_err(|e| format!("Failed to run adb start-server: {e}"))?;
    let stdout = String::from_utf8_lossy(&start.stdout).trim().to_string();
    if start.status.success() {
        eprintln!("adb_restart_server: OK");
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&start.stderr);
        eprintln!("adb_restart_server: FAILED: {}", stderr);
        Err(format!("ADB start-server failed: {stderr}"))
    }
}

#[tauri::command]
pub fn adb_disconnect(app: tauri::AppHandle, host_port: String) -> Result<String, String> {
    let settings = read_settings(&app);
    eprintln!("adb_disconnect: {}", host_port);
    let output = no_window_command(&settings.adb_path)
        .args(["disconnect", &host_port])
        .output()
        .map_err(|e| format!("Failed to run adb: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        eprintln!("adb_disconnect: OK: {}", stdout);
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("adb_disconnect: FAILED: {}", stderr);
        Err(format!("ADB disconnect failed: {stderr}"))
    }
}

// ── Device nicknames ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_device_nickname(
    app: tauri::AppHandle,
    stable_id: String,
    nickname: String,
) -> Result<(), String> {
    let settings = read_settings(&app);
    let mut new_settings = settings.clone();
    if nickname.trim().is_empty() {
        new_settings.device_nicknames.remove(&stable_id);
    } else {
        new_settings
            .device_nicknames
            .insert(stable_id, nickname.trim().to_string());
    }
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

// ── Wireless device management ───────────────────────────────────────────────

#[tauri::command]
pub fn save_wireless_device(app: tauri::AppHandle, host_port: String) -> Result<String, String> {
    let settings = read_settings(&app);
    let mut wireless_devices = settings.wireless_devices.clone();
    if !wireless_devices.contains(&host_port) {
        wireless_devices.push(host_port.clone());
    }
    let mut new_settings = settings.clone();
    new_settings.wireless_devices = wireless_devices;
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(host_port)
}

#[tauri::command]
pub fn remove_wireless_device(app: tauri::AppHandle, host_port: String) -> Result<String, String> {
    let settings = read_settings(&app);
    let wireless_devices: Vec<String> = settings
        .wireless_devices
        .clone()
        .into_iter()
        .filter(|d| d != &host_port)
        .collect();
    let mut new_settings = settings.clone();
    new_settings.wireless_devices = wireless_devices;
    let path = crate::settings::settings_path(&app)
        .map_err(|e| format!("Cannot get settings path: {e}"))?;
    let contents =
        serde_json::to_string_pretty(&new_settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Write error: {e}"))?;
    Ok(host_port)
}

#[tauri::command]
pub fn get_wireless_devices(app: tauri::AppHandle) -> Vec<String> {
    let settings = read_settings(&app);
    settings.wireless_devices
}

// ── Launch ───────────────────────────────────────────────────────────────────

fn launch_mirror_inner(
    _app: &tauri::AppHandle,
    settings: &Settings,
    serial: &str,
) -> Result<LaunchResult, String> {
    let key = format!("__mirror__:{serial}");
    let window_title = format!("scrcpy-launcher:mirror:{serial}");
    eprintln!("launch_mirror: serial={} title={}", serial, window_title);

    let maybe_child = {
        let mut map = CHILDREN.lock().unwrap();
        map.remove(&key)
    };
    if let Some(mut child) = maybe_child {
        if let Ok(None) = child.try_wait() {
            let pid = child.id();
            CHILDREN.lock().unwrap().insert(key, child);
            std::thread::spawn(move || focus_window(pid));
            return Ok(LaunchResult {
                used_flex_display: false,
                message: None,
            });
        }
    }

    let display_bounds = settings
        .device_display_bounds
        .get(serial)
        .map(String::as_str)
        .or(if settings.display_bounds.is_empty() {
            None
        } else {
            Some(settings.display_bounds.as_str())
        });
    let supports_bounds = display_bounds.is_some() && scrcpy_supports_display_bounds(settings);

    let mut args = vec![
        "-s".to_string(),
        serial.to_string(),
        "--window-title".to_string(),
        window_title,
    ];

    // Merge scrcpy arguments: Global -> Device
    args.extend(split_args(&settings.global_scrcpy_args));
    let sid = stable_folder_id(settings, serial);
    if let Some(device_args) = settings.device_scrcpy_args.get(&sid) {
        args.extend(split_args(device_args));
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
pub fn launch_mirror(app: tauri::AppHandle, serial: String) -> Result<LaunchResult, String> {
    let settings = read_settings(&app);
    launch_mirror_inner(&app, &settings, &serial)
}


#[tauri::command]
pub fn launch_app(
    app: tauri::AppHandle,
    serial: String,
    package_name: String,
    label: String,
) -> Result<LaunchResult, String> {
    let settings = read_settings(&app);
    let window_title = format!("scrcpy-launcher:{package_name}:{serial}");
    eprintln!(
        "launch_app: pkg={} serial={} title={} label={}",
        package_name, serial, window_title, label
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

    let app_id = scrcpy_app_id(&package_name);
    let cache = cache::snapshot();
    let icon_path = cache
        .get(&package_name)
        .and_then(|meta| meta.icon_data_url.as_ref())
        .and_then(|url| save_app_icon(&package_name, url));

    app_desktop_write(&app_id, &label, icon_path.as_deref().unwrap_or("scrcpy"));

    if let Ok(mut ids) = ACTIVE_APP_IDS.lock() {
        ids.insert(app_id.clone());
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
        serial.clone(),
        "--new-display".to_string(),
        "--start-app".to_string(),
        format!("+{package_name}"),
        "--window-title".to_string(),
        window_title,
        "--display-ime-policy=local".to_string(),
        "--no-audio".to_string(),
    ];

    // Merge scrcpy arguments: Global -> Device -> App
    args.extend(split_args(&settings.global_scrcpy_args));
    let sid = stable_folder_id(&settings, &serial);
    if let Some(device_args) = settings.device_scrcpy_args.get(&sid) {
        args.extend(split_args(device_args));
    }
    if let Some(app_args) = settings.app_scrcpy_args.get(&package_name) {
        args.extend(split_args(app_args));
    }

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
        .env("SDL_VIDEO_WAYLAND_WMCLASS", &app_id)
        .env("SDL_VIDEO_X11_WMCLASS", &app_id)
        .env("SDL_APP_ID", &app_id)
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

// ── Update Check ─────────────────────────────────────────────────────────────

fn parse_version(v: &str) -> Vec<u32> {
    v.trim_start_matches('v')
        .split('.')
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

#[tauri::command]
pub fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    let settings = read_settings(&app);
    let current = env!("CARGO_PKG_VERSION");
    let current_parts = parse_version(current);
    if current_parts.len() != 3 {
        return Ok(String::new());
    }

    let url = "https://api.github.com/repos/richardred15/scrcpy-launcher/releases/latest";
    let response = ureq::get(url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "scrcpy-launcher")
        .call()
        .map_err(|e| format!("GitHub API error: {e}"))?;

    let body = response
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("Failed to read response: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("JSON parse error: {e}"))?;

    let latest_tag = json["tag_name"].as_str().unwrap_or("").to_string();
    if latest_tag.is_empty() {
        return Ok(String::new());
    }

    let latest = latest_tag.trim_start_matches('v');
    if latest == settings.ignored_update_version {
        return Ok(String::new());
    }

    let latest_parts = parse_version(&latest_tag);
    if latest_parts.len() != 3 {
        return Ok(String::new());
    }

    // Compare major.minor.patch
    if latest_parts > current_parts {
        Ok(latest_tag)
    } else {
        Ok(String::new())
    }
}
