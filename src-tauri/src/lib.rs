mod adb;
mod cache;
mod commands;
mod icon;
mod platform;
mod runtime;
mod settings;
mod types;
mod web;
mod worker;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;

use platform::{cleanup_stale_app_data, register_desktop_file, TerminalGuard};
use runtime::kill_children;
use worker::{worker_loop, RefreshFlag};

pub fn run() {
    register_desktop_file();
    cleanup_stale_app_data();
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    let saved = std::process::Command::new("stty")
        .arg("-g")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());

    let _guard = TerminalGuard(saved.clone());

    let hook_saved = saved.clone();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(ref s) = hook_saved {
            let _ = std::process::Command::new("stty")
                .args([s.as_str()])
                .status();
        }
        prev(info);
    }));

    let exit_flag = Arc::new(AtomicBool::new(false));
    let worker_exit = exit_flag.clone();
    let worker_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let setup_handle = worker_handle.clone();

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_folder,
            commands::add_app_to_folder,
            commands::remove_app_from_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::launch_app,
            commands::launch_mirror,
            commands::launch_mirror_multi,
            commands::adb_connect,
            commands::adb_disconnect,
            commands::adb_restart_server,
            commands::save_wireless_device,
            commands::remove_wireless_device,
            commands::get_wireless_devices,
            commands::get_cached_app_meta,
            commands::resolve_app_batch,
            commands::get_notification_counts,
            worker::get_open_apps,
            worker::trigger_refresh,
            worker::trigger_load_apps,
            commands::install_scrcpy_windows,
        ])
        .setup(move |a| {
            cache::init(a.handle());
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

    app.run(|handle, event| match event {
        tauri::RunEvent::Exit
        | tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            kill_children(handle);
        }
        _ => {}
    });

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
