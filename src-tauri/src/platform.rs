use base64::Engine;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

static KDOTOOL_PATH: OnceLock<String> = OnceLock::new();

pub fn kdotool_path() -> &'static str {
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

pub fn focus_window(pid: u32) -> bool {
    let status = Command::new(kdotool_path())
        .args(["search", "--pid", &pid.to_string(), "windowactivate"])
        .status();
    if let Ok(s) = status {
        if s.success() {
            return true;
        }
    }
    Command::new("xdotool")
        .args(["search", "--pid", &pid.to_string(), "windowactivate"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn xdg_data_home() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".local").join("share"))
                .unwrap_or_else(|_| PathBuf::from("/tmp"))
        })
}

pub fn xdg_cache_home() -> PathBuf {
    std::env::var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".cache"))
                .unwrap_or_else(|_| PathBuf::from("/tmp"))
        })
}

pub fn scrcpy_app_id(package: &str) -> String {
    let sanitized: String = package
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("scrcpy-launcher-{sanitized}")
}

pub fn save_app_icon(package: &str, icon_data_url: &str) -> Option<String> {
    let b64 = icon_data_url.split(";base64,").nth(1)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(b64.trim()).ok()?;
    let dir = xdg_cache_home()
        .join("dev.scrcpy-launcher")
        .join("app-icons");
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{package}.png"));
    fs::write(&path, &bytes).ok()?;
    Some(path.to_string_lossy().to_string())
}

pub fn app_desktop_write(app_id: &str, label: &str, icon_path: &str) {
    let apps_dir = xdg_data_home().join("applications");
    if fs::create_dir_all(&apps_dir).is_err() {
        return;
    }
    let content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={label}\n\
         Exec=scrcpy\n\
         Icon={icon_path}\n\
         Terminal=false\n\
         Categories=Utility;\n\
         NoDisplay=true\n\
         StartupNotify=true\n\
         StartupWMClass={app_id}\n"
    );
    let path = apps_dir.join(format!("{app_id}.desktop"));
    if fs::write(&path, content).is_err() {
        eprintln!("[scrcpy-launcher] app_desktop_write: failed for {app_id}");
        return;
    }
    std::thread::spawn(|| {
        std::process::Command::new("kbuildsycoca6")
            .arg("--noincremental")
            .status()
            .ok();
    });
}

pub fn app_desktop_cleanup(app_id: &str) {
    let desktop = xdg_data_home()
        .join("applications")
        .join(format!("{app_id}.desktop"));
    let _ = fs::remove_file(&desktop);
}

pub fn cleanup_stale_app_data() {
    let apps_dir = xdg_data_home().join("applications");
    let Ok(entries) = fs::read_dir(&apps_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("scrcpy-launcher-") && name.ends_with(".desktop") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub struct TerminalGuard(pub Option<String>);

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if let Some(ref s) = self.0 {
            let _ = Command::new("stty").args([s.as_str()]).status();
        }
    }
}

pub fn register_desktop_file() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let data_dir = std::env::var("XDG_DATA_HOME")
        .unwrap_or_else(|_| format!("{home}/.local/share"));
    let apps_dir = PathBuf::from(&data_dir).join("applications");
    let icons_base = PathBuf::from(&data_dir).join("icons").join("hicolor");

    let exe = std::env::current_exe().ok();
    let exe_path = exe
        .as_ref()
        .and_then(|p| {
            let s = p.to_string_lossy();
            if s.starts_with("/") {
                Some(s.to_string())
            } else {
                None
            }
        });
    let exe_path = match exe_path {
        Some(p) => p,
        None => return,
    };

    fs::create_dir_all(&apps_dir).ok();

    let desktop = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=scrcpy Launcher\n\
         Exec={exe_path}\n\
         Icon=dev.scrcpy-launcher\n\
         Terminal=false\n\
         Categories=Utility;\n\
         StartupNotify=true\n\
         StartupWMClass=dev.scrcpy-launcher\n"
    );
    if fs::write(apps_dir.join("dev.scrcpy-launcher.desktop"), desktop).is_err() {
        eprintln!("[scrcpy-launcher] failed to write .desktop file");
    }

    let icon_bytes = include_bytes!("../icons/icon.png");
    if let Ok(img) = image::load_from_memory(icon_bytes) {
        for &size in &[32, 64, 128, 256, 512] {
            let dir = icons_base.join(format!("{size}x{size}")).join("apps");
            if fs::create_dir_all(&dir).is_err() {
                continue;
            }
            let resized = img.resize_exact(size, size, image::imageops::FilterType::Lanczos3);
            let path = dir.join("dev.scrcpy-launcher.png");
            if resized.save(&path).is_err() {
                eprintln!("[scrcpy-launcher] failed to save icon {size}x{size}");
            }
        }
    } else {
        eprintln!("[scrcpy-launcher] failed to decode embedded icon");
    }

    std::process::Command::new("kbuildsycoca6")
        .arg("--noincremental")
        .status()
        .ok();
}
