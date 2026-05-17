# scrcpy Launcher

Launch Android apps as separate desktop windows via scrcpy virtual displays.

Built with Tauri 2 + Rust + Vanilla TypeScript. No Electron, no heavyweight framework.

## Features

- **One click per app** — lists all launcher-enabled packages from a connected Android device
- **Multiple desktops** — each app opens in its own resizable scrcpy window
- **Smart focus** — clicking a running app focuses its existing window (kdotool on KDE Wayland, xdotool fallback on X11)
- **Web metadata** — resolves app names and icons from Google Play / F-Droid with ADB fallback; caches results to disk
- **Single instance** — no duplicate scrcpy processes for the same app
- **Custom binary paths** — configure adb and scrcpy locations in the settings panel
- **Flexible virtual display** — opt-in `--flex-display` for scrcpy ≥4.0
- **Kill-on-close** — optionally terminate all scrcpy children when the launcher exits

## Requirements

### Runtime

| Dependency | Required | Purpose |
|---|---|---|
| [Android platform-tools (adb)](https://developer.android.com/tools/adb) | Yes | Device communication and app queries |
| [scrcpy](https://github.com/Genymobile/scrcpy) | Yes | Screen mirroring and virtual displays |
| [kdotool](https://github.com/jinliu/kdotool) | KDE Wayland only | Window focus via KWin scripting API |
| [xdotool](https://github.com/jordansissel/xdotool) | X11 fallback | Window focus on X11/XWayland |

### Build

- Node.js ≥18
- Rust toolchain (Cargo)
- Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

## Installation

### From source

```sh
git clone https://github.com/your-username/scrcpy-launcher
cd scrcpy-launcher
npm install
cargo install kdotool                    # KDE Wayland window focus
npm run tauri:dev                        # development mode with hot-reload
npm run tauri build                      # production binary
```

### Dependencies

```sh
# Arch / CachyOS
sudo pacman -S android-tools scrcpy xdotool
cargo install kdotool

# Debian / Ubuntu
sudo apt install android-sdk-platform-tools scrcpy xdotool
cargo install kdotool

# Fedora
sudo dnf install android-tools scrcpy xdotool
cargo install kdotool

# macOS
brew install android-platform-tools scrcpy

# Windows (not yet supported)
scoop install adb scrcpy
```

## Usage

1. Enable **USB debugging** on your Android device
2. Connect the device and authorize the connection
3. Launch scrcpy-launcher — it auto-detects the device and lists installed apps
4. Click any app card to open it in a new scrcpy window
5. Click the card again while the window is open to focus it

The settings panel lets you:
- Point to custom adb/scrcpy binaries
- Toggle system package visibility
- Enable flexible virtual display (scrcpy ≥4.0)
- Choose icon source (generated placeholders or web metadata)
- Toggle kill-on-close behaviour

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Tauri 2 (Rust)                  │
│                                                  │
│  launch_app                                      │
│    ├─ Child::try_wait() ── liveness check        │
│    ├─ scrcpy --new-display --start-app           │
│    └─ focus_window(pid)  (on background thread)  │
│         ├─ kdotool search --pid windowactivate   │
│         └─ xdotool search --pid windowactivate   │
│                                                  │
│  resolve_app_batch  (background thread)          │
│    ├─ Google Play scrape  (rate-limited)         │
│    ├─ F-Droid scrape      (rate-limited)         │
│    └─ ADB icon extraction (ZIP EOCD parsing)     │
│                                                  │
│  WindowTracker  (managed Tauri state)            │
│    └─ HashMap<pkg, Child> + Drop cleanup         │
└─────────────────────────────────────────────────┘
         │                      ▲
         │ Tauri commands/events│
         ▼                      │
┌─────────────────────────────────────────────────┐
│                Frontend (Vanilla TS)             │
│                                                  │
│  Layered rendering:                              │
│    1. Instant grid from pretty_label             │
│    2. Merge disk cache on mount                  │
│    3. Fire-and-forget resolve batch              │
│    4. Update cards via app-meta-resolved events  │
└─────────────────────────────────────────────────┘
```

### Focus mechanism

On KDE Wayland, the launcher uses **kdotool** which invokes KWin's scripting D-Bus API (`org.kde.kwin.Scripting.loadScript`). On X11, it falls back to **xdotool** (`search --pid windowactivate`). Both run on a background thread so the UI never blocks.

A previous iteration used raw `wayland-client` with `dlopen` and then direct `zbus` D-Bus calls, but these were replaced with kdotool for simplicity and reliability.

### Metadata resolution

App names and icons are resolved lazily (never block startup):
1. Instant: show `pretty_label` (derived from package name)
2. Fast: fill from on-disk cache
3. Background: scrape Google Play → F-Droid → ADB icon extraction
4. Per-app Tauri events update individual cards in-place

## Development

```sh
npm install
npm run tauri:dev      # hot-reload frontend + Rust backend
npm run tauri build    # release binary in src-tauri/target/release
npm run build          # frontend only
```

## Configuration

Settings are persisted to `$XDG_CONFIG_HOME/scrcpy-launcher/settings.json` (Linux) or the equivalent OS-specific path.

## Known limitations

- **Windows support**: not yet implemented (needs winapi `SetForegroundWindow` for focus)
- **Samsung API 36+**: `dumpsys package` no longer emits `application-label:`, making web scraping the only source of correct app names for Samsung OneUI 7 devices
- **Split APKs**: `pm path` returns multiple lines — only the base APK is used for icon extraction
- **System app icons**: Samsung system apps (Messaging, Camera) use OneUI adaptive icons from the system theme, not bundled PNGs, so they fall through to the coloured-circle fallback
- **scrcpy version**: `--flex-display` requires scrcpy ≥4.0
