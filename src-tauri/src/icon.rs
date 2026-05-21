use std::io::Read;

use apk_info_axml::{AXML, ARSC};
use base64::Engine;

use crate::adb::adb_shell;
use crate::types::{ParsedIconEntry, Settings};

pub fn extract_icon_adb(settings: &Settings, serial: &str, package_name: &str) -> Option<String> {
    eprintln!("[scrcpy-launcher] icon: extracting for {package_name}");

    let output = adb_shell(settings, serial, &["pm", "path", package_name]).ok()?;
    let apk_path = output.lines().next()?.strip_prefix("package:")?.trim();
    if apk_path.is_empty() {
        eprintln!("[scrcpy-launcher] icon: empty APK path for {package_name}");
        return None;
    }
    eprintln!("[scrcpy-launcher] icon: APK path = {apk_path}");

    let engine = base64::engine::general_purpose::STANDARD;

    let cmd = format!("tail -c 65536 '{}' 2>/dev/null | base64", apk_path);
    let output = match adb_shell(settings, serial, &[&cmd]) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: tail -c failed: {e}");
            return None;
        }
    };
    let tail_b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
    let mut tail = match engine.decode(&tail_b64) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[scrcpy-launcher] icon: base64 decode failed (tail): {e}");
            return None;
        }
    };
    eprintln!(
        "[scrcpy-launcher] icon: tail read {} bytes for {package_name}",
        tail.len()
    );

    let (eocd_buf_off, cd_offset, cd_size) = find_eocd_with_offset(&tail)?;
    eprintln!(
        "[scrcpy-launcher] icon: EOCD at buf offset {}, CD offset={}, size={}",
        eocd_buf_off, cd_offset, cd_size
    );

    let total_needed = cd_size as usize + 22;
    let read_size = std::cmp::max(65536, total_needed);
    if read_size > 65536 {
        if read_size > 5_000_000 {
            eprintln!(
                "[scrcpy-launcher] icon: CD too large ({} MB) for {package_name}",
                read_size / 1_000_000
            );
            return None;
        }
        let cmd = format!("tail -c {} '{}' 2>/dev/null | base64", read_size, apk_path);
        let output = match adb_shell(settings, serial, &[&cmd]) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[scrcpy-launcher] icon: re-read failed: {e}");
                return None;
            }
        };
        let b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
        tail = engine.decode(&b64).ok()?;
        eprintln!(
            "[scrcpy-launcher] icon: re-read {} bytes for {package_name}",
            tail.len()
        );
    }

    let (eocd_buf_off, _cd_offset, cd_size) = find_eocd_with_offset(&tail)?;

    let cd_start: usize = if eocd_buf_off >= cd_size as usize {
        eocd_buf_off - cd_size as usize
    } else {
        eprintln!(
            "[scrcpy-launcher] icon: CD ({} bytes) still too large after re-read for {package_name}",
            cd_size
        );
        return None;
    };

    if cd_start >= tail.len() {
        eprintln!(
            "[scrcpy-launcher] icon: CD start out of bounds ({cd_start} >= {})",
            tail.len()
        );
        return None;
    }
    let cd_data = &tail[cd_start..];

    if let Some(icon) = resolve_icon_via_arsc(settings, serial, apk_path, cd_data, package_name, &engine) {
        return Some(icon);
    }

    let icon_entry = find_best_icon_entry(cd_data);

    if let Some(ref entry) = icon_entry {
        if entry.filename.ends_with(".xml") {
            return try_adaptive_icon(
                settings, serial, apk_path, cd_data, package_name, &engine, None,
            );
        }
        eprintln!(
            "[scrcpy-launcher] icon: found '{}' (compression={}, size={}, data_start={})",
            entry.filename, entry.compression_method, entry.compressed_size, entry.data_start
        );
        let data = pull_entry(settings, serial, apk_path, entry, &engine)?;
        let mime = if entry.filename.ends_with(".png") {
            "image/png"
        } else if entry.filename.ends_with(".webp") {
            "image/webp"
        } else {
            "image/png"
        };
        eprintln!(
            "[scrcpy-launcher] icon: success for {package_name} ({} bytes {})",
            data.len(),
            mime
        );
        return Some(format!("data:{};base64,{}", mime, engine.encode(&data)));
    }

    try_adaptive_icon(settings, serial, apk_path, cd_data, package_name, &engine, None)
}

fn find_entry_exact_filename(cd_data: &[u8], target: &str) -> Option<ParsedIconEntry> {
    let mut pos = 0;
    while pos + 46 <= cd_data.len() {
        if &cd_data[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let compression = u16::from_le_bytes([cd_data[pos + 10], cd_data[pos + 11]]);
        if compression != 0 && compression != 8 {
            let name_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 28..pos + 30].try_into().ok()?,
            ));
            let extra_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 30..pos + 32].try_into().ok()?,
            ));
            let comment_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 32..pos + 34].try_into().ok()?,
            ));
            pos += 46 + name_len + extra_len + comment_len;
            continue;
        }
        let comp_size = u64::from(u32::from_le_bytes(
            cd_data[pos + 20..pos + 24].try_into().ok()?,
        ));
        let name_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 28..pos + 30].try_into().ok()?,
        ));
        let extra_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 30..pos + 32].try_into().ok()?,
        ));
        let comment_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 32..pos + 34].try_into().ok()?,
        ));
        let local_offset = u64::from(u32::from_le_bytes(
            cd_data[pos + 42..pos + 46].try_into().ok()?,
        ));
        if pos + 46 + name_len <= cd_data.len() {
            let filename = std::str::from_utf8(&cd_data[pos + 46..pos + 46 + name_len]).ok()?;
            if filename == target {
                let data_start = local_offset + 30 + name_len as u64 + extra_len as u64;
                return Some(ParsedIconEntry {
                    filename: filename.to_string(),
                    compression_method: compression,
                    compressed_size: comp_size,
                    data_start,
                });
            }
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    None
}

fn resolve_icon_via_arsc(
    settings: &Settings,
    serial: &str,
    apk_path: &str,
    cd_data: &[u8],
    package_name: &str,
    engine: &base64::engine::GeneralPurpose,
) -> Option<String> {
    eprintln!(
        "[scrcpy-launcher] icon: resolving via ARSC for {package_name}"
    );

    let manifest_entry = find_entry_exact_filename(cd_data, "AndroidManifest.xml")?;
    let manifest_data = pull_entry(settings, serial, apk_path, &manifest_entry, engine)?;

    let arsc_entry = find_entry_exact_filename(cd_data, "resources.arsc")?;
    let arsc_data = pull_entry(settings, serial, apk_path, &arsc_entry, engine)?;

    let arsc = ARSC::new(&mut &arsc_data[..]).ok()?;
    let axml = AXML::new(&mut &manifest_data[..], Some(&arsc)).ok()?;

    let icon_ref = axml
        .get_attribute_value("application", "icon", Some(&arsc))
        .or_else(|| axml.get_attribute_value("application", "roundIcon", Some(&arsc)))?;

    if !icon_ref.starts_with("res/") {
        eprintln!(
            "[scrcpy-launcher] icon: ARSC value '{icon_ref}' is not a res path for {package_name}"
        );
        return None;
    }

    if icon_ref.ends_with(".xml") {
        let xml_entry = find_entry_exact_filename(cd_data, &icon_ref)?;
        return try_adaptive_icon(
            settings, serial, apk_path, cd_data, package_name, engine, Some(xml_entry),
        );
    }

    let icon_entry = find_entry_exact_filename(cd_data, &icon_ref)?;
    let data = pull_entry(settings, serial, apk_path, &icon_entry, engine)?;
    let mime = if icon_ref.ends_with(".png") {
        "image/png"
    } else if icon_ref.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };
    eprintln!(
        "[scrcpy-launcher] icon: ARSC success for {package_name} ({} bytes {})",
        data.len(),
        mime
    );
    Some(format!("data:{};base64,{}", mime, engine.encode(&data)))
}

fn try_adaptive_icon(
    settings: &Settings,
    serial: &str,
    apk_path: &str,
    cd_data: &[u8],
    package_name: &str,
    engine: &base64::engine::GeneralPurpose,
    xml_entry: Option<ParsedIconEntry>,
) -> Option<String> {
    eprintln!(
        "[scrcpy-launcher] icon: trying adaptive icon for {package_name}"
    );
    let xml_entry = xml_entry.or_else(|| find_adaptive_icon_xml(cd_data))?;
    let xml_data = pull_entry(settings, serial, apk_path, &xml_entry, engine)?;
    let (fg_name, bg_name) = parse_adaptive_icon_xml(&xml_data)?;
    eprintln!(
        "[scrcpy-launcher] icon: adaptive layers: fg={fg_name}, bg={bg_name}"
    );
    let fg_entry = find_drawable_entry(cd_data, &fg_name)?;
    let bg_entry = find_drawable_entry(cd_data, &bg_name)?;
    let fg_data = pull_entry(settings, serial, apk_path, &fg_entry, engine)?;
    let bg_data = pull_entry(settings, serial, apk_path, &bg_entry, engine)?;
    let composited = composite_adaptive_icon(&fg_data, &bg_data)?;
    eprintln!(
        "[scrcpy-launcher] icon: adaptive icon composited for {package_name} ({} bytes)",
        composited.len()
    );
    Some(format!(
        "data:image/png;base64,{}",
        engine.encode(&composited)
    ))
}

fn find_eocd_with_offset(tail: &[u8]) -> Option<(usize, u64, u64)> {
    for i in (0..tail.len().saturating_sub(22)).rev() {
        if &tail[i..i + 4] == b"PK\x05\x06" {
            let eocd = &tail[i..];
            let cd_offset = u64::from(u32::from_le_bytes(eocd[16..20].try_into().ok()?));
            let cd_size = u64::from(u32::from_le_bytes(eocd[12..16].try_into().ok()?));
            if cd_offset == 0xFFFFFFFF {
                return None;
            }
            return Some((i, cd_offset, cd_size));
        }
    }
    None
}

fn is_icon_filename(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    (lower.starts_with("res/")
        && lower.contains("ic_")
        && (lower.ends_with(".png") || lower.ends_with(".webp"))
        && !lower.contains("_foreground")
        && !lower.contains("_background"))
        || (lower.starts_with("res/")
            && lower.contains("ic_")
            && lower.ends_with(".xml")
            && lower.contains("anydpi"))
}

fn icon_score(filename: &str) -> i32 {
    let lower = filename.to_lowercase();
    let mut score = 100;
    if !lower.contains("_round") {
        score += 50;
    }
    if lower.contains("-xxxhdpi") {
        score += 500;
    } else if lower.contains("-xxhdpi") {
        score += 400;
    } else if lower.contains("-xhdpi") {
        score += 300;
    } else if lower.contains("-hdpi") {
        score += 200;
    } else if lower.contains("-mdpi") {
        score += 100;
    }
    if lower.ends_with(".png") {
        score += 20;
    }
    score
}

fn find_best_icon_entry(cd_data: &[u8]) -> Option<ParsedIconEntry> {
    let mut best: Option<ParsedIconEntry> = None;
    let mut best_score = -1;
    let mut pos = 0;
    while pos + 46 <= cd_data.len() {
        if &cd_data[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let compression = u16::from_le_bytes([cd_data[pos + 10], cd_data[pos + 11]]);
        if compression != 0 && compression != 8 {
            let name_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 28..pos + 30].try_into().ok()?,
            ));
            let extra_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 30..pos + 32].try_into().ok()?,
            ));
            let comment_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 32..pos + 34].try_into().ok()?,
            ));
            pos += 46 + name_len + extra_len + comment_len;
            continue;
        }
        let comp_size = u64::from(u32::from_le_bytes(
            cd_data[pos + 20..pos + 24].try_into().ok()?,
        ));
        let name_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 28..pos + 30].try_into().ok()?,
        ));
        let extra_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 30..pos + 32].try_into().ok()?,
        ));
        let comment_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 32..pos + 34].try_into().ok()?,
        ));
        let local_offset = u64::from(u32::from_le_bytes(
            cd_data[pos + 42..pos + 46].try_into().ok()?,
        ));
        if pos + 46 + name_len <= cd_data.len() {
            let filename = std::str::from_utf8(&cd_data[pos + 46..pos + 46 + name_len]).ok()?;
            if is_icon_filename(filename) {
                let score = icon_score(filename);
                if score > best_score {
                    let data_start = local_offset + 30 + name_len as u64 + extra_len as u64;
                    best = Some(ParsedIconEntry {
                        filename: filename.to_string(),
                        compression_method: compression,
                        compressed_size: comp_size,
                        data_start,
                    });
                    best_score = score;
                }
            }
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    best
}

fn pull_entry(
    settings: &Settings,
    serial: &str,
    apk_path: &str,
    entry: &ParsedIconEntry,
    engine: &base64::engine::GeneralPurpose,
) -> Option<Vec<u8>> {
    let cmd = format!(
        "dd if='{}' bs=1 skip={} count={} 2>/dev/null | base64",
        apk_path, entry.data_start, entry.compressed_size
    );
    let output = adb_shell(settings, serial, &[&cmd]).ok()?;
    let b64: String = output.chars().filter(|c| !c.is_whitespace()).collect();
    let compressed = engine.decode(&b64).ok()?;
    if compressed.len() as u64 != entry.compressed_size {
        return None;
    }
    if entry.compression_method == 0 {
        Some(compressed)
    } else if entry.compression_method == 8 {
        let mut decoder = flate2::read::DeflateDecoder::new(&compressed[..]);
        let mut buf = Vec::with_capacity(entry.compressed_size as usize * 4);
        decoder.read_to_end(&mut buf).ok()?;
        Some(buf)
    } else {
        None
    }
}

fn find_adaptive_icon_xml(cd_data: &[u8]) -> Option<ParsedIconEntry> {
    let mut xml_entry: Option<ParsedIconEntry> = None;
    let mut pos = 0;
    while pos + 46 <= cd_data.len() {
        if &cd_data[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let name_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 28..pos + 30].try_into().ok()?,
        ));
        let extra_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 30..pos + 32].try_into().ok()?,
        ));
        let comment_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 32..pos + 34].try_into().ok()?,
        ));
        let comp_size = u64::from(u32::from_le_bytes(
            cd_data[pos + 20..pos + 24].try_into().ok()?,
        ));
        let local_offset = u64::from(u32::from_le_bytes(
            cd_data[pos + 42..pos + 46].try_into().ok()?,
        ));
        if pos + 46 + name_len <= cd_data.len() {
            let filename = std::str::from_utf8(&cd_data[pos + 46..pos + 46 + name_len]).ok()?;
            let lower = filename.to_lowercase();
            if lower.contains("anydpi") && lower.contains("ic_") && lower.ends_with(".xml")
            {
                let data_start = local_offset + 30 + name_len as u64 + extra_len as u64;
                xml_entry = Some(ParsedIconEntry {
                    filename: filename.to_string(),
                    compression_method: u16::from_le_bytes([cd_data[pos + 10], cd_data[pos + 11]]),
                    compressed_size: comp_size,
                    data_start,
                });
            }
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    xml_entry
}

fn parse_adaptive_icon_xml(xml_data: &[u8]) -> Option<(String, String)> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let mut reader = Reader::from_reader(xml_data);
    let mut foreground = None;
    let mut background = None;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e))
                if e.name().as_ref() == b"foreground" || e.name().as_ref() == b"background" =>
            {
                let is_fg = e.name().as_ref() == b"foreground";
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"drawable"
                        || attr.key.as_ref()
                            == b"{http://schemas.android.com/apk/res/android}drawable"
                    {
                        let val = std::str::from_utf8(&attr.value).ok()?;
                        let name = val.rsplit('/').next()?;
                        if is_fg {
                            foreground = Some(name.to_string());
                        } else {
                            background = Some(name.to_string());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    Some((foreground?, background?))
}

fn find_drawable_entry(cd_data: &[u8], drawable_name: &str) -> Option<ParsedIconEntry> {
    let lower_name = drawable_name.to_lowercase();
    let mut best: Option<ParsedIconEntry> = None;
    let mut best_score = -1;
    let mut pos = 0;
    while pos + 46 <= cd_data.len() {
        if &cd_data[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let compression = u16::from_le_bytes([cd_data[pos + 10], cd_data[pos + 11]]);
        if compression != 0 && compression != 8 {
            let name_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 28..pos + 30].try_into().ok()?,
            ));
            let extra_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 30..pos + 32].try_into().ok()?,
            ));
            let comment_len = usize::from(u16::from_le_bytes(
                cd_data[pos + 32..pos + 34].try_into().ok()?,
            ));
            pos += 46 + name_len + extra_len + comment_len;
            continue;
        }
        let comp_size = u64::from(u32::from_le_bytes(
            cd_data[pos + 20..pos + 24].try_into().ok()?,
        ));
        let name_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 28..pos + 30].try_into().ok()?,
        ));
        let extra_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 30..pos + 32].try_into().ok()?,
        ));
        let comment_len = usize::from(u16::from_le_bytes(
            cd_data[pos + 32..pos + 34].try_into().ok()?,
        ));
        let local_offset = u64::from(u32::from_le_bytes(
            cd_data[pos + 42..pos + 46].try_into().ok()?,
        ));
        if pos + 46 + name_len <= cd_data.len() {
            let filename = std::str::from_utf8(&cd_data[pos + 46..pos + 46 + name_len]).ok()?;
            let lower = filename.to_lowercase();
            if lower.contains(&lower_name) && (lower.ends_with(".png") || lower.ends_with(".webp"))
            {
                let data_start = local_offset + 30 + name_len as u64 + extra_len as u64;
                let entry = ParsedIconEntry {
                    filename: filename.to_string(),
                    compression_method: compression,
                    compressed_size: comp_size,
                    data_start,
                };
                let score = icon_score(filename);
                if score > best_score {
                    best_score = score;
                    best = Some(entry);
                }
            }
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    best
}

fn composite_adaptive_icon(foreground: &[u8], background: &[u8]) -> Option<Vec<u8>> {
    use image::GenericImageView;
    let fg = image::load_from_memory(foreground).ok()?;
    let bg = image::load_from_memory(background).ok()?;
    let (bw, bh) = bg.dimensions();
    let fg = fg.resize_exact(bw, bh, image::imageops::FilterType::Lanczos3);
    let mut canvas = bg.to_rgba8();
    image::imageops::overlay(&mut canvas, &fg.to_rgba8(), 0, 0);
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::from(canvas)
        .write_to(&mut buf, image::ImageFormat::Png)
        .ok()?;
    Some(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_icon_filename_valid_png() {
        assert!(is_icon_filename("res/mipmap-hdpi/ic_launcher.png"));
    }

    #[test]
    fn test_is_icon_filename_valid_webp() {
        assert!(is_icon_filename("res/mipmap-hdpi/ic_launcher.webp"));
    }

    #[test]
    fn test_is_icon_filename_foreground() {
        assert!(!is_icon_filename(
            "res/mipmap-hdpi/ic_launcher_foreground.png"
        ));
    }

    #[test]
    fn test_is_icon_filename_background() {
        assert!(!is_icon_filename(
            "res/mipmap-hdpi/ic_launcher_background.png"
        ));
    }

    #[test]
    fn test_is_icon_filename_not_in_res() {
        assert!(!is_icon_filename("assets/ic_launcher.png"));
    }

    #[test]
    fn test_is_icon_filename_not_launcher() {
        assert!(!is_icon_filename("res/drawable/other.png"));
    }

    #[test]
    fn test_icon_score_prefers_non_round() {
        let round = icon_score("res/mipmap-xxhdpi/ic_launcher_round.png");
        let normal = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        assert!(normal > round);
    }

    #[test]
    fn test_icon_score_prefers_higher_density() {
        let mdpi = icon_score("res/mipmap-mdpi/ic_launcher.png");
        let xxhdpi = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        assert!(xxhdpi > mdpi);
    }

    #[test]
    fn test_icon_score_prefers_png_over_webp() {
        let png = icon_score("res/mipmap-xxhdpi/ic_launcher.png");
        let webp = icon_score("res/mipmap-xxhdpi/ic_launcher.webp");
        assert!(png > webp);
    }

    #[test]
    fn test_find_eocd_with_offset_found() {
        let mut buf = vec![0u8; 100];
        let cd_offset: u32 = 42;
        let cd_size: u32 = 128;
        buf[50..54].copy_from_slice(b"PK\x05\x06");
        buf[62..66].copy_from_slice(&cd_size.to_le_bytes());
        buf[66..70].copy_from_slice(&cd_offset.to_le_bytes());
        let tail = &buf[30..];
        let result = find_eocd_with_offset(tail);
        assert!(result.is_some());
        let (buf_off, eocd_cd_off, eocd_cd_size) = result.unwrap();
        assert_eq!(buf_off, 20);
        assert_eq!(eocd_cd_off, cd_offset as u64);
        assert_eq!(eocd_cd_size, cd_size as u64);
    }

    #[test]
    fn test_find_eocd_with_offset_not_found() {
        assert!(find_eocd_with_offset(b"no PK signature here").is_none());
    }

    #[test]
    fn test_find_eocd_with_offset_empty() {
        assert!(find_eocd_with_offset(b"").is_none());
    }
}
