use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use crate::adb;
use crate::runtime::get_open_apps_list;
use crate::settings::read_settings_from_file;
use crate::types::{AndroidApp, AppsLoadedEvent, BinaryStatus, Device, Settings, ToolStatus};

pub struct RefreshFlag(pub Arc<AtomicBool>);

pub fn worker_loop(app_handle: tauri::AppHandle, flag: Arc<AtomicBool>, exit: Arc<AtomicBool>) {
    loop {
        if exit.load(Ordering::Relaxed) {
            return;
        }

        let settings = read_settings_from_file();

        let tools = compute_tool_status(&settings);
        let _ = app_handle.emit("tool-status-updated", &tools);

        let devices = compute_devices(&settings);
        let _ = app_handle.emit("devices-updated", &devices);

        let open_apps = get_open_apps_list();
        let _ = app_handle.emit("open-apps-updated", &open_apps);

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

fn compute_tool_status(settings: &Settings) -> ToolStatus {
    let adb_version = adb::run_command(&settings.adb_path, &["version"]).ok();
    let scrcpy_version = adb::run_command(&settings.scrcpy_path, &["--version"]).ok();
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
    let output = match adb::adb(settings, None, &["devices"]) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut devices = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let raw_serial = parts[0];
        let state = parts.get(1).unwrap_or(&"unknown").to_string();
        let wireless = raw_serial.starts_with('*')
            || raw_serial.contains("tcpip:")
            || raw_serial.contains("wireless:");
        let serial = raw_serial.trim_start_matches('*').to_string();
        if state != "device" {
            devices.push(Device {
                serial: serial.clone(),
                state,
                model: None,
                android_version: None,
                battery_level: None,
                battery_temperature: None,
                battery_charging: None,
                wireless,
            });
            continue;
        }
        let model = adb::adb_shell(settings, &serial, &["getprop", "ro.product.model"]).ok();
        let android_version =
            adb::adb_shell(settings, &serial, &["getprop", "ro.build.version.release"]).ok();
        let battery = adb::adb_shell(settings, &serial, &["dumpsys", "battery"]).ok();
        let (battery_level, battery_temperature, battery_charging) = battery
            .as_deref()
            .map(adb::parse_battery_info)
            .unwrap_or_default();
        devices.push(Device {
            serial: serial.clone(),
            state,
            model: model.filter(|v| !v.is_empty()),
            android_version: android_version.filter(|v| !v.is_empty()),
            battery_level,
            battery_temperature,
            battery_charging,
            wireless,
        });
    }
    devices
}

fn compute_apps(settings: &Settings, serial: &str) -> Vec<AndroidApp> {
    use std::collections::HashMap;

    let mut apps_map: HashMap<String, AndroidApp> = HashMap::new();

    if let Ok(output) = adb::adb_shell(
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
            if let Some((package_name, activity)) = adb::parse_activity_line(line) {
                apps_map.entry(package_name.clone()).or_insert(AndroidApp {
                    label: adb::pretty_label(&package_name),
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
        if let Ok(output) = adb::adb_shell(settings, serial, &package_args) {
            for line in output.lines() {
                if let Some(package_name) = adb::parse_package_line(line) {
                    apps_map.entry(package_name.clone()).or_insert(AndroidApp {
                        label: adb::pretty_label(&package_name),
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

#[tauri::command]
pub fn get_open_apps() -> Vec<String> {
    get_open_apps_list()
}

#[tauri::command]
pub fn trigger_refresh(flag: tauri::State<RefreshFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn trigger_load_apps(app_handle: tauri::AppHandle, serial: String) {
    std::thread::spawn(move || {
        let settings = read_settings_from_file();
        let apps = compute_apps(&settings, &serial);
        let _ = app_handle.emit("apps-loaded", AppsLoadedEvent { serial, apps });
    });
}
