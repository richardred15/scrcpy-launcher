use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use crate::adb;
use crate::discovery;
use crate::runtime::get_open_apps_list;
use crate::settings::read_settings;
use crate::types::{AndroidApp, AppsLoadedEvent, BinaryStatus, Device, Settings, ToolStatus};

pub struct RefreshFlag(pub Arc<AtomicBool>);
pub struct ScanFlag(pub Arc<AtomicBool>);

fn run_mdns_scan(settings: &Settings, devices: &[Device], app_handle: &tauri::AppHandle) {
    let discovered = discovery::discover_adb_devices();
    let connected_serials: Vec<String> = devices.iter().map(|d| d.serial.clone()).collect();
    for svc in &discovered {
        if svc.service_type == "_adb-tls-connect._tcp" {
            let host_port = format!("{}:{}", svc.host, svc.port);
            if !connected_serials
                .iter()
                .any(|s| s.contains(&host_port) || s.contains(&svc.host))
            {
                let _ = adb::adb_timeout(
                    settings,
                    None,
                    &["connect", &host_port],
                    Duration::from_secs(5),
                );
            }
        }
    }
    let _ = app_handle.emit("wireless-scan-result", &discovered);
}

pub fn worker_loop(
    app_handle: tauri::AppHandle,
    flag: Arc<AtomicBool>,
    scan_flag: Arc<AtomicBool>,
    exit: Arc<AtomicBool>,
) {
    let mut mdns_counter: u32 = 0;
    let mut adb_server_restarted = false;
    let mut last_tool_paths = (String::new(), String::new());
    let mut cached_tools: Option<ToolStatus> = None;

    loop {
        if exit.load(Ordering::Relaxed) {
            return;
        }

        let settings = read_settings(&app_handle);

        // On first iteration, restart ADB server so it picks up ADB_MDNS_OPENSCREEN
        if !adb_server_restarted {
            adb_server_restarted = true;
            let _ = adb::adb(&settings, None, &["kill-server"]);
        }

        // Re-check tool status only when paths change (binaries don't change at runtime)
        let current_paths = (settings.adb_path.clone(), settings.scrcpy_path.clone());
        if cached_tools.is_none() || current_paths != last_tool_paths {
            cached_tools = Some(compute_tool_status(&settings));
            last_tool_paths = current_paths;
        }
        let _ = app_handle.emit("tool-status-updated", cached_tools.as_ref().unwrap());

        let devices = compute_devices(&settings);
        let _ = app_handle.emit("devices-updated", &devices);

        let open_apps = get_open_apps_list();
        let _ = app_handle.emit("open-apps-updated", &open_apps);

        mdns_counter += 1;
        if mdns_counter >= 6 {
            mdns_counter = 0;
            run_mdns_scan(&settings, &devices, &app_handle);
        }

        for _ in 0..100 {
            if exit.load(Ordering::Relaxed) {
                return;
            }
            let do_refresh = flag.swap(false, Ordering::Relaxed);
            let do_scan = scan_flag.swap(false, Ordering::Relaxed);
            if do_refresh || do_scan {
                let settings = read_settings(&app_handle);
                let devices = compute_devices(&settings);
                let _ = app_handle.emit("devices-updated", &devices);
                if do_scan {
                    mdns_counter = 0;
                    run_mdns_scan(&settings, &devices, &app_handle);
                }
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
            || raw_serial.contains("wireless:")
            || raw_serial.contains(':');
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
                stable_id: serial.clone(),
            });
            continue;
        }
        let t = Duration::from_secs(5);
        let model =
            adb::adb_shell_timeout(settings, &serial, &["getprop", "ro.product.model"], t).ok();
        let android_version = adb::adb_shell_timeout(
            settings,
            &serial,
            &["getprop", "ro.build.version.release"],
            t,
        )
        .ok();
        let battery = adb::adb_shell_timeout(settings, &serial, &["dumpsys", "battery"], t).ok();
        let (battery_level, battery_temperature, battery_charging) = battery
            .as_deref()
            .map(adb::parse_battery_info)
            .unwrap_or_default();
        let stable_id = adb::adb_shell_timeout(settings, &serial, &["getprop", "ro.serialno"], t)
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| serial.clone());
        devices.push(Device {
            serial: serial.clone(),
            state,
            model: model.filter(|v| !v.is_empty()),
            android_version: android_version.filter(|v| !v.is_empty()),
            battery_level,
            battery_temperature,
            battery_charging,
            wireless,
            stable_id,
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
pub fn trigger_scan(scan_flag: tauri::State<ScanFlag>) {
    scan_flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn trigger_load_apps(app_handle: tauri::AppHandle, serial: String) {
    std::thread::spawn(move || {
        let settings = read_settings(&app_handle);
        let apps = compute_apps(&settings, &serial);
        let _ = app_handle.emit("apps-loaded", AppsLoadedEvent { serial, apps });
    });
}
