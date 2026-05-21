use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub adb_path: String,
    pub scrcpy_path: String,
    pub include_system_apps: bool,
    pub icon_source: IconSource,
    #[serde(default)]
    pub flex_display: bool,
    #[serde(default)]
    pub web_enabled: bool,
    #[serde(default)]
    pub adb_fallback: bool,
    #[serde(default)]
    pub kill_on_close: bool,
    #[serde(default)]
    pub display_bounds: String,
    #[serde(default)]
    pub device_display_bounds: HashMap<String, String>,
    #[serde(default)]
    pub wireless_devices: Vec<String>,
    #[serde(default)]
    pub last_wireless_host: String,
    #[serde(default)]
    pub last_wireless_port: String,
    #[serde(default)]
    pub folders: HashMap<String, HashMap<String, Folder>>,
    #[serde(default)]
    pub device_nicknames: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IconSource {
    Web,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub adb: BinaryStatus,
    pub scrcpy: BinaryStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub path: String,
    pub found: bool,
    pub version: Option<String>,
    pub help: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
    pub android_version: Option<String>,
    pub battery_level: Option<u32>,
    pub battery_temperature: Option<f32>,
    pub battery_charging: Option<bool>,
    pub wireless: bool,
    pub stable_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidApp {
    pub package_name: String,
    pub activity: Option<String>,
    pub label: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAppMeta {
    pub label: String,
    pub icon_data_url: Option<String>,
    pub source: String,
    pub resolved_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetaResolvedEvent {
    pub package_name: String,
    pub label: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub used_flex_display: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsLoadedEvent {
    pub serial: String,
    pub apps: Vec<AndroidApp>,
}

pub struct ParsedIconEntry {
    pub filename: String,
    pub compression_method: u16,
    pub compressed_size: u64,
    pub data_start: u64,
}
