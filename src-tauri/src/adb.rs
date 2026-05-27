use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::types::Settings;

pub fn no_window_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("ADB_MDNS_OPENSCREEN", "1");
    cmd.env("ADB_MDNS_AUTO_CONNECT", "adb-tls-connect");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = no_window_command(program);
    command.args(args);
    let output = command
        .output()
        .map_err(|err| format!("Failed to run {program}: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            stderr
        })
    }
}

/// Run a command with a hard timeout. Kills the child process if the deadline is exceeded.
pub fn run_command_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = no_window_command(program);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = command.spawn().map_err(|e| format!("Failed to spawn {program}: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Failed to wait for {program}: {e}"));
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| format!("Failed to read output: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            stderr
        })
    }
}

pub fn adb_timeout(settings: &Settings, serial: Option<&str>, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut all_args = Vec::new();
    if let Some(serial) = serial {
        all_args.extend(["-s", serial]);
    }
    all_args.extend_from_slice(args);
    run_command_timeout(&settings.adb_path, &all_args, timeout)
}

pub fn adb_shell_timeout(settings: &Settings, serial: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut all_args = vec!["shell"];
    all_args.extend_from_slice(args);
    adb_timeout(settings, Some(serial), &all_args, timeout)
}

pub fn adb(settings: &Settings, serial: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut all_args = Vec::new();
    if let Some(serial) = serial {
        all_args.extend(["-s", serial]);
    }
    all_args.extend_from_slice(args);
    run_command(&settings.adb_path, &all_args)
}

pub fn adb_shell(settings: &Settings, serial: &str, args: &[&str]) -> Result<String, String> {
    let mut all_args = vec!["shell"];
    all_args.extend_from_slice(args);
    adb(settings, Some(serial), &all_args)
}

pub fn pretty_label(package_name: &str) -> String {
    let tail = package_name.rsplit('.').next().unwrap_or(package_name);
    let with_spaces = tail
        .chars()
        .fold(String::with_capacity(tail.len() + 5), |mut s, c| {
            if c.is_uppercase()
                && !s.is_empty()
                && s.chars().last().is_some_and(|p| p.is_lowercase())
            {
                s.push(' ');
            }
            s.push(c);
            s
        });
    with_spaces
        .split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_package_line(line: &str) -> Option<String> {
    line.strip_prefix("package:")
        .map(|value| value.rsplit('=').next().unwrap_or(value).trim().to_string())
}

pub fn parse_activity_line(line: &str) -> Option<(String, String)> {
    let clean = line.trim();
    if clean.is_empty()
        || clean.starts_with("activity:")
        || clean.starts_with("priority=")
        || clean.starts_with("No activities found")
    {
        return None;
    }
    let component = clean.split_whitespace().last()?;
    let (package_name, activity) = component.split_once('/')?;
    Some((package_name.to_string(), activity.to_string()))
}

pub fn scrcpy_supports_flex_display(settings: &Settings) -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        run_command(&settings.scrcpy_path, &["--help"])
            .map(|help| help.contains("--flex-display") || help.contains("-x, --flex-display"))
            .unwrap_or(false)
    })
}

pub fn scrcpy_supports_display_bounds(settings: &Settings) -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        run_command(&settings.scrcpy_path, &["--help"])
            .map(|help| help.contains("--display-bounds"))
            .unwrap_or(false)
    })
}

pub fn parse_battery_info(output: &str) -> (Option<u32>, Option<f32>, Option<bool>) {
    let mut level = None;
    let mut temperature = None;
    let mut charging = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("level: ") {
            level = rest.trim().parse::<u32>().ok();
        } else if let Some(rest) = trimmed.strip_prefix("temperature: ") {
            temperature = rest.trim().parse::<u32>().ok().map(|t| t as f32 / 10.0);
        } else if let Some(rest) = trimmed.strip_prefix("status: ") {
            charging = rest.trim().parse::<u32>().ok().map(|s| s == 2 || s == 5);
        }
    }
    (level, temperature, charging)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pretty_label_simple() {
        assert_eq!(pretty_label("com.example.myapp"), "Myapp");
    }

    #[test]
    fn test_pretty_label_camel_case() {
        assert_eq!(pretty_label("com.example.myApp"), "My App");
    }

    #[test]
    fn test_pretty_label_underscore() {
        assert_eq!(pretty_label("com.example.my_app"), "My App");
    }

    #[test]
    fn test_pretty_label_hyphen() {
        assert_eq!(pretty_label("com.example.my-app"), "My App");
    }

    #[test]
    fn test_pretty_label_complex() {
        assert_eq!(pretty_label("com.android.vending"), "Vending");
    }

    #[test]
    fn test_pretty_label_single_word() {
        assert_eq!(pretty_label("simple"), "Simple");
    }

    #[test]
    fn test_parse_package_line_simple() {
        assert_eq!(
            parse_package_line("package:com.example.app"),
            Some("com.example.app".into())
        );
    }

    #[test]
    fn test_parse_package_line_no_match() {
        assert_eq!(parse_package_line("some other line"), None);
    }

    #[test]
    fn test_parse_package_line_with_equals() {
        assert_eq!(
            parse_package_line("package:com.example.app=123"),
            Some("123".into())
        );
    }

    #[test]
    fn test_parse_activity_line_valid() {
        let result = parse_activity_line("  com.example.app/.MainActivity");
        assert_eq!(
            result,
            Some(("com.example.app".into(), ".MainActivity".into()))
        );
    }

    #[test]
    fn test_parse_activity_line_activity_prefix() {
        let result = parse_activity_line("activity=com.example.app/.Main");
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "activity=com.example.app");
    }

    #[test]
    fn test_parse_activity_line_priority() {
        assert_eq!(parse_activity_line("priority=1"), None);
    }

    #[test]
    fn test_parse_activity_line_no_activities() {
        assert_eq!(parse_activity_line("No activities found"), None);
    }

    #[test]
    fn test_parse_activity_line_empty() {
        assert_eq!(parse_activity_line(""), None);
    }

    #[test]
    fn test_parse_activity_line_whitespace() {
        assert_eq!(parse_activity_line("   "), None);
    }

    #[test]
    fn test_parse_battery_info_full() {
        let (lvl, temp, chg) = parse_battery_info("  level: 85\n  temperature: 350\n  status: 2\n");
        assert_eq!(lvl, Some(85));
        assert_eq!(temp, Some(35.0));
        assert_eq!(chg, Some(true));
    }

    #[test]
    fn test_parse_battery_info_discharging() {
        let (lvl, temp, chg) = parse_battery_info("  level: 42\n  temperature: 310\n  status: 3\n");
        assert_eq!(lvl, Some(42));
        assert_eq!(temp, Some(31.0));
        assert_eq!(chg, Some(false));
    }

    #[test]
    fn test_parse_battery_info_full_status() {
        let (_, _, chg) = parse_battery_info("  status: 5\n");
        assert_eq!(chg, Some(true));
    }

    #[test]
    fn test_parse_battery_info_not_found() {
        let (lvl, temp, chg) = parse_battery_info("  voltage: 4348\n  technology: Li-ion\n");
        assert_eq!(lvl, None);
        assert_eq!(temp, None);
        assert_eq!(chg, None);
    }

    #[test]
    fn test_parse_battery_info_empty() {
        let (lvl, temp, chg) = parse_battery_info("");
        assert_eq!(lvl, None);
        assert_eq!(temp, None);
        assert_eq!(chg, None);
    }
}
