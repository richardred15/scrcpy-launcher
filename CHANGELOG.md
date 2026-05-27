# Changelog

## Unreleased

### Added
- mDNS network device discovery via `mdns-sd` crate — scans `_adb._tcp`, `_adb-tls-pairing._tcp`, `_adb-tls-connect._tcp` on the local network
- Background polling: every ~60s the worker scans for wireless devices and auto-connects paired TLS devices
- "Scan for Devices" button discovers nearby Android devices with wireless debugging enabled
- Discovered devices shown in empty state with type badges (Ready / Pairing Needed / Legacy)
- `ADB_MDNS_OPENSCREEN=1` and `ADB_MDNS_AUTO_CONNECT=adb-tls-connect` env vars set on all ADB subprocesses
- APK installation: added "Install APK" button with file picker and drag-and-drop support for .apk files
- Folder renaming: added "Rename" option to folder context menu and a dedicated rename modal
- Keyboard shortcuts: Ctrl+R (refresh), Ctrl+F (focus search), and Escape (close modals)
- Per-device notification badge showing total notifications on the selected device pill
- Custom scrcpy arguments: Global, per-device, and per-app overrides with merged launch logic
- mDNS pairing flow: "Pair" button for pairing-needed devices and pairing code modal



### Changed
- Replaced `adb mdns services` with direct mDNS discovery (Linux ADB server doesn't register the `host:mdns:*` services)
- Connection guide now only shows after first mDNS scan completes with no devices found
- Wireless form closes immediately on successful connect
- IPv4 only for discovered device addresses
- `devices-updated` handler no longer reloads entire UI when only a non-selected device is added or removed; only the device selector dropdown updates

### Fixed
- Clippy `single_match` warning in `discovery.rs`
- Duplicate scroll-sticky logic unified into single `updateStickyState` import

### Removed
- Dead code: `launchMirrorAll`/`launch_mirror_multi` (frontend + backend)
- Dead state fields: `appLoadToken`, `loadingIcons`, `lastReadyDeviceKey`, `guideScanDone`
- Unused imports: `selectedDevice`, `readyDeviceKey` in `events.ts`
- Vestigial `#[allow(unused_mut)]` on `no_window_command`
- Debug `console.log` statements from production code
- `catch (e: any)` replaced with `catch (e: unknown)` throughout

## v0.1.7

### Added
- Custom titlebar: removed native window decorations, added 28px titlebar with minimize/maximize/close buttons via `@tauri-apps/api/window`
- Version badge in titlebar brand area
- Update check: fetches latest GitHub release via `check_for_updates` command, shows modal with Download / Ignore buttons
- Drag & drop folder management: drag apps onto each other to create folders, into folders to add, out of folders to remove
- Visual drag feedback (`.drag-over`, `.dragging` CSS)

### Fixed
- ACL permissions for custom titlebar window controls (`core:window:allow-*`)

## v0.1.6

### Fixed
- Per-app taskbar icons for scrcpy v4 + SDL3

## v0.1.5

### Fixed
- CI: set rust-cache workspaces to `src-tauri`
- Formatting in `icon.rs`

## v0.1.4

### Added
- NSIS `installMode currentUser` for per-user Windows install

## v0.1.3

### Added
- Windows scrcpy + ADB download button in Connection Guide modal
- Remove apps from folders and delete folders

### Fixed
- 5 Windows launch fixes + centralized settings path
- Use `ureq` v3 API for Windows compat

### Changed
- Screenshot now hosted from repo (`docs/screenshots/latest.png`)
- README release download table

## v0.1.2

### Added
- Per-device folders
- Globalized app metadata cache
- Multi-mirror launch
- Device cards
- Adaptive icon extraction (ZIP EOCD parsing, foreground/background compositing)
- Wireless ADB support with pairing flow
- 145 Vitest unit tests for all frontend modules
- Battery temperature and charging status
- Replace native dialogs with glass modals

### Changed
- Split monolithic Rust backend into 9 modules (types, adb, web, icon, platform, settings, runtime, worker, commands)
- Split monolithic `main.ts` into modular files (types, state, utils, render, actions, events)
- Unified favorites into folder system
- Rate-limited icon resolution with 4 parallel workers

## v0.1.0

Initial release with core ADB app launching via scrcpy.
