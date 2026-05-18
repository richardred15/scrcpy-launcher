use base64::Engine;
use std::io::Read;
use std::time::{Duration, Instant};

use scraper::{Html, Selector};
use ureq::config::Config;

fn http_agent() -> ureq::Agent {
    let config = Config::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(20)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn fetch_body(url: &str) -> Result<String, String> {
    let agent = http_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("HTTP error: {e}"))?;
    resp.into_body()
        .read_to_string()
        .map_err(|e| format!("Read error: {e}"))
}

pub fn download_icon_as_data_url(url: &str) -> Option<String> {
    let bytes = fetch_bytes(url).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let mime = if bytes.len() > 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    {
        "image/png"
    } else if bytes.len() > 4
        && bytes[..4] == [0x52, 0x49, 0x46, 0x46]
        && bytes.len() > 12
        && bytes[8..12] == [0x57, 0x45, 0x42, 0x50]
    {
        "image/webp"
    } else {
        "image/png"
    };
    Some(format!("data:{};base64,{}", mime, engine.encode(&bytes)))
}

fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let agent = http_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("HTTP error: {e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    resp.into_body()
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("Read error: {e}"))?;
    Ok(buf)
}

pub fn rate_limit(last: &mut Instant, interval: Duration) {
    let elapsed = last.elapsed();
    if elapsed < interval {
        std::thread::sleep(interval - elapsed);
    }
    *last = Instant::now();
}

pub fn scrape_google_play(pkg: &str) -> Option<(String, String)> {
    let url = format!("https://play.google.com/store/apps/details?id={pkg}");
    eprintln!("  google: {url}");
    let body = fetch_body(&url).ok()?;
    let doc = Html::parse_document(&body);

    let title_sel = Selector::parse("meta[property='og:title']").ok()?;
    let title = doc.select(&title_sel).next()?.value().attr("content")?;
    let label = if let Some(idx) = title.rfind(" - ") {
        title[..idx].to_string()
    } else {
        title.to_string()
    };
    if label.is_empty() {
        return None;
    }

    let og_image_sel = Selector::parse("meta[property='og:image']").ok()?;
    let icon_url = doc
        .select(&og_image_sel)
        .next()?
        .value()
        .attr("content")?
        .to_string();

    if icon_url.is_empty() {
        return None;
    }

    eprintln!("got label={label:?} icon={icon_url:?}");
    Some((label, icon_url))
}

pub fn scrape_fdroid(pkg: &str) -> Option<(String, String)> {
    let url = format!("https://f-droid.org/packages/{pkg}/");
    eprintln!("  fdroid: {url}");
    let body = fetch_body(&url).ok()?;
    let doc = Html::parse_document(&body);

    let title_sel = Selector::parse("title").ok()?;
    let title = doc.select(&title_sel).next()?.inner_html();
    let label = if let Some(idx) = title.rfind(" | ") {
        title[..idx].to_string()
    } else {
        title
    };
    if label.is_empty() {
        return None;
    }

    let icon_sel = Selector::parse("img.package-icon").ok()?;
    let icon_url = doc
        .select(&icon_sel)
        .next()?
        .value()
        .attr("src")?
        .to_string();
    let icon_url = if icon_url.starts_with('/') {
        format!("https://f-droid.org{icon_url}")
    } else {
        icon_url
    };

    eprintln!("got label={label:?} icon={icon_url:?}");
    Some((label, icon_url))
}
