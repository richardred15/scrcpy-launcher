use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use tauri::Manager;

use crate::types::Settings;

pub fn default_settings() -> Settings {
    Settings {
        adb_path: "adb".into(),
        scrcpy_path: "scrcpy".into(),
        include_system_apps: false,
        icon_source: crate::types::IconSource::None,
        flex_display: true,
        web_enabled: true,
        adb_fallback: true,
        kill_on_close: true,
        display_bounds: "540x960".into(),
        device_display_bounds: HashMap::new(),
        wireless_devices: Vec::new(),
        folders: HashMap::new(), // HashMap<serial, HashMap<folder_id, Folder>>
    }
}

pub fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to locate config directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create config directory: {err}"))?;
    dir.push("settings.json");
    Ok(dir)
}

pub fn read_settings(app: &tauri::AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return default_settings();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return default_settings();
    };
    serde_json::from_str(&contents).unwrap_or_else(|_| default_settings())
}

pub fn read_settings_from_file() -> Settings {
    let path = settings_file_path();
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_settings)
}

pub fn settings_file_path() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            PathBuf::from(home).join(".config")
        });
    base.join("scrcpy-launcher").join("settings.json")
}

pub fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Unable to locate cache directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("Unable to create cache directory: {err}"))?;
    dir.push("app_metadata_cache.json");
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
