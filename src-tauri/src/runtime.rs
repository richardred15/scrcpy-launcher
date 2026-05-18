use std::collections::{HashMap, HashSet};
use std::fs;
use std::process::{Child, Command};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::platform::app_desktop_cleanup;
use crate::settings::{default_settings, settings_file_path};
use crate::types::Settings;

pub static CHILDREN: LazyLock<Mutex<HashMap<String, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub static ACTIVE_APP_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn kill_children() {
    let settings: Settings = fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
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

    let mut app_ids = ACTIVE_APP_IDS.lock().unwrap_or_else(|e| e.into_inner());
    for app_id in app_ids.drain() {
        app_desktop_cleanup(&app_id);
    }

    eprintln!("[scrcpy-launcher] kill_children: done");
}

pub fn get_open_apps_list() -> Vec<String> {
    let mut open_apps = Vec::new();
    if let Ok(mut children) = CHILDREN.lock() {
        children.retain(|key, child| match child.try_wait() {
            Ok(None) => {
                if !key.starts_with("__mirror__") {
                    open_apps.push(key.clone());
                }
                true
            }
            _ => false,
        });
    }
    open_apps
}
