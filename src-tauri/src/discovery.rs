use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};

use crate::types::MdnsDiscoveredDevice;

const SERVICE_TYPES: &[&str] = &[
    "_adb._tcp.local.",
    "_adb-tls-pairing._tcp.local.",
    "_adb-tls-connect._tcp.local.",
];

pub fn discover_adb_devices() -> Vec<MdnsDiscoveredDevice> {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(_) => return vec![],
    };

    let mut receivers = Vec::new();
    for stype in SERVICE_TYPES {
        if let Ok(rx) = daemon.browse(stype) {
            receivers.push(rx);
        }
    }

    if receivers.is_empty() {
        return vec![];
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
                    let stype = info
                        .ty_domain
                        .trim_end_matches(".local.")
                        .to_string();
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

    devices
}
