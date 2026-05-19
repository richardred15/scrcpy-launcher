use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{LazyLock, Mutex};

use crate::settings;
use crate::types::CachedAppMeta;

static CACHE_MANAGER: LazyLock<Mutex<CacheManager>> =
    LazyLock::new(|| Mutex::new(CacheManager::new()));

pub enum CacheAction {
    Cached(CachedAppMeta),
    Pending(Receiver<CachedAppMeta>),
    Resolve,
}

struct PendingEntry {
    waiters: Vec<std::sync::mpsc::Sender<CachedAppMeta>>,
}

struct CacheManager {
    cache: HashMap<String, CachedAppMeta>,
    pending: HashMap<String, PendingEntry>,
    cache_path: Option<PathBuf>,
    loaded: bool,
}

impl CacheManager {
    fn new() -> Self {
        CacheManager {
            cache: HashMap::new(),
            pending: HashMap::new(),
            cache_path: None,
            loaded: false,
        }
    }
}

pub fn init(app_handle: &tauri::AppHandle) {
    let mut mgr = CACHE_MANAGER.lock().unwrap();
    if mgr.loaded {
        return;
    }
    if let Ok(path) = settings::cache_path(app_handle) {
        mgr.cache_path = Some(path.clone());
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(cache) = serde_json::from_str(&contents) {
                mgr.cache = cache;
            }
        }
    }
    mgr.loaded = true;
}

pub fn request(pkg: &str) -> CacheAction {
    let mut mgr = CACHE_MANAGER.lock().unwrap();
    if let Some(meta) = mgr.cache.get(pkg) {
        return CacheAction::Cached(meta.clone());
    }
    if let Some(entry) = mgr.pending.get_mut(pkg) {
        let (tx, rx) = mpsc::channel();
        entry.waiters.push(tx);
        return CacheAction::Pending(rx);
    }
    let (tx, _rx) = mpsc::channel();
    mgr.pending
        .insert(pkg.to_string(), PendingEntry { waiters: vec![tx] });
    CacheAction::Resolve
}

pub fn store(pkg: String, meta: CachedAppMeta) {
    let mut mgr = CACHE_MANAGER.lock().unwrap();
    mgr.cache.insert(pkg.clone(), meta.clone());
    if let Some(entry) = mgr.pending.remove(&pkg) {
        for tx in entry.waiters {
            let _ = tx.send(meta.clone());
        }
    }
}

pub fn snapshot() -> HashMap<String, CachedAppMeta> {
    let mgr = CACHE_MANAGER.lock().unwrap();
    mgr.cache.clone()
}

pub fn flush() {
    let mgr = CACHE_MANAGER.lock().unwrap();
    if let Some(ref path) = mgr.cache_path {
        if let Ok(contents) = serde_json::to_string_pretty(&mgr.cache) {
            let _ = std::fs::write(path, contents);
        }
    }
}
