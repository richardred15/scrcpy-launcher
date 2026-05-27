use std::sync::Mutex;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};

use crate::types::MdnsDiscoveredDevice;

const SERVICE_TYPES: &[&str] = &[
    "_adb._tcp.local.",
    "_adb-tls-pairing._tcp.local.",
    "_adb-tls-connect._tcp.local.",
];

// Persistent daemon avoids repeated multicast query bursts from new daemon initialization.
static DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

fn get_daemon() -> Option<ServiceDaemon> {
    let mut guard = DAEMON.lock().ok()?;
    if guard.is_none() {
        *guard = ServiceDaemon::new().ok();
    }
    guard.clone()
}

fn reset_daemon() {
    if let Ok(mut guard) = DAEMON.lock() {
        *guard = None;
    }
}

pub fn discover_adb_devices() -> Vec<MdnsDiscoveredDevice> {
    let daemon = match get_daemon() {
        Some(d) => d,
        None => return vec![],
    };

    let mut receivers = Vec::new();
    for stype in SERVICE_TYPES {
        match daemon.browse(stype) {
            Ok(rx) => receivers.push(rx),
            Err(_) => {
                // Daemon is unhealthy — reset and bail; next call will recreate it
                reset_daemon();
                return vec![];
            }
        }
    }

    let mut devices: Vec<MdnsDiscoveredDevice> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        let mut got_event = false;
        for rx in &receivers {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
                got_event = true;
                if let ServiceEvent::ServiceResolved(info) = event {
                    let port = info.port;
                    let stype = info.ty_domain.trim_end_matches(".local.").to_string();
                    for addr in &info.addresses {
                        if !matches!(addr, mdns_sd::ScopedIp::V4(_)) {
                            continue;
                        }
                        devices.push(MdnsDiscoveredDevice {
                            service_name: info.fullname.clone(),
                            service_type: stype.clone(),
                            host: addr.to_string(),
                            port,
                        });
                    }
                }
            }
        }

        if !got_event && !devices.is_empty() {
            break;
        }
    }

    // Stop browsing to avoid accumulating receivers on the persistent daemon
    for stype in SERVICE_TYPES {
        let _ = daemon.stop_browse(stype);
    }

    devices
}
