import { version } from "../package.json";
import { state, stableIdForSerial } from "./state";
import type { AndroidApp, Folder, BinaryStatus, Device } from "./types";
import {
    shellEscapeText,
    iconSeed,
    initials,
    selectedDevice,
    isFavorited,
    filteredApps,
} from "./utils";
import {
    createIcons,
    Battery,
    BatteryCharging,
    BatteryFull,
    BatteryLow,
    BatteryMedium,
    ChevronDown,
    MonitorSmartphone,
    Play,
    RefreshCw,
    Search,
    Server,
    Settings,
    Smartphone,
    Trash2,
    Usb,
    Wifi,
    X,
    Download,
    Upload,
} from "lucide";

export function renderStatusPill(binary: BinaryStatus, label: string): string {
    const ok = binary.found ? "ok" : "bad";
    const version = binary.version;
    const tooltip = version ? `${label} ${version}` : binary.help;
    return `
    <div class="pill ${ok}" title="${shellEscapeText(tooltip)}">
      <span class="dot"></span>
      <span>${label}</span>
    </div>
  `;
}

function batteryIcon(level?: number): string {
    if (level === undefined) return "";
    if (level > 75) return `<i data-lucide="battery-full"></i>`;
    if (level > 25) return `<i data-lucide="battery-medium"></i>`;
    return `<i data-lucide="battery-low"></i>`;
}

export function renderDeviceSelect(): string {
    if (state.loadingDevices) {
        return `<div class="device-chip muted"><i data-lucide="refresh-cw"></i><span>Finding devices</span></div>`;
    }

    if (state.devices.length === 0) {
        return `<div class="device-chip warning"><span class="dot"></span><span>No devices</span></div>`;
    }

    const selected = state.devices.find(d => d.serial === state.selectedSerial) ?? state.devices[0];
    const icon = selected.wireless ? "wifi" : "usb";
    const nickname = state.settings?.deviceNicknames?.[selected.stableId];
    const name = nickname ?? selected.model ?? selected.serial;
    const batteryHtml = selected.batteryLevel !== undefined
        ? `<span class="device-badge">${selected.batteryCharging ? '<i data-lucide="battery-charging"></i>' : batteryIcon(selected.batteryLevel)} ${selected.batteryLevel}%</span>`
        : "";
    const tempHtml = selected.batteryTemperature !== undefined
        ? `<span class="device-badge">${selected.batteryTemperature.toFixed(1)}°C</span>`
        : "";

    const totalNotifications = Object.values(state.notificationCounts).reduce((a, b) => a + b, 0);
    const notifHtml = totalNotifications > 0
        ? `<span class="device-notif-badge" title="Notifications">${totalNotifications}</span>`
        : "";

    const isSelected = state.devices.some(d => d.serial === state.selectedSerial);
    const cls = isSelected ? "device-pill selected" : "device-pill";

    const dropdownHtml = state.devices.length > 1
        ? `<div class="device-pill-dropdown">${state.devices.map(d => {
            const optIcon = d.wireless ? "wifi" : "usb";
            const optNick = state.settings?.deviceNicknames?.[d.stableId];
            const optLabel = [optNick, d.model, d.serial].filter(Boolean).join(" · ");
            const optSelected = d.serial === state.selectedSerial ? " selected" : "";
            return `<div class="device-pill-option${optSelected}" data-serial="${shellEscapeText(d.serial)}">
              <i data-lucide="${optIcon}"></i>
              <span>${shellEscapeText(optLabel)}</span>
            </div>`;
        }).join("")}</div>`
        : "";

    const chevron = state.devices.length > 1 ? `<i data-lucide="chevron-down"></i>` : "";

    return `
    <div class="${cls}">
      <div class="device-pill-trigger">
        <i data-lucide="${icon}"></i>
        <span class="device-card-name">${shellEscapeText(name)}</span>
        ${chevron}
      </div>
      ${dropdownHtml}
      ${batteryHtml}
      ${tempHtml}
      ${notifHtml}
      <button class="icon-button tiny" data-mirror="${shellEscapeText(selected.serial)}" title="Mirror"><i data-lucide="monitor-smartphone"></i></button>
    </div>`;
}

export function renderBatteryPill(): string {
    const device = selectedDevice();
    if (!device || device.batteryLevel === undefined) return "";
    const icon = device.batteryCharging
        ? `<i data-lucide="battery-charging"></i>`
        : batteryIcon(device.batteryLevel);
    return `<div class="pill" title="Battery">${icon} ${device.batteryLevel}%</div>`;
}

export function renderTempPill(): string {
    const device = selectedDevice();
    if (!device || device.batteryTemperature === undefined) return "";
    const temp = device.batteryTemperature;
    return `<div class="pill" title="Temperature">${temp.toFixed(1)}°C</div>`;
}

export function renderWirelessForm(): string {
    let btnLabel = "Connect";
    let btnClass = "primary-button small";
    if (state.wirelessConnecting) {
        btnLabel = "Connecting…";
    } else if (state.wirelessConnectResult === "ok") {
        btnLabel = "Connected";
        btnClass = "primary-button small connected";
    } else if (state.wirelessConnectResult === "error") {
        btnLabel = "Connect";
    }
    const errHtml = state.wirelessConnectResult === "error" && state.wirelessConnectMsg
        ? `<div class="wireless-error">${shellEscapeText(state.wirelessConnectMsg)}</div>`
        : "";
    return `
    <div class="wireless-form">
      <div class="wireless-fields">
        <input id="wirelessHost" value="${shellEscapeText(state.wirelessHost)}" placeholder="192.168.1.100" autocomplete="off" spellcheck="false" ${state.wirelessConnecting ? "disabled" : ""} />
        <span class="wireless-port-sep">:</span>
        <input id="wirelessPort" value="${shellEscapeText(state.wirelessPort)}" placeholder="5555" autocomplete="off" spellcheck="false" ${state.wirelessConnecting ? "disabled" : ""} />
      </div>
      <button class="${btnClass}" id="doWirelessConnect" ${state.wirelessConnecting || state.wirelessConnectResult === "ok" ? "disabled" : ""}>${btnLabel}</button>
      <span class="wireless-close" id="closeWirelessForm">&times;</span>
      ${errHtml}
    </div>
  `;
}

export function renderAppIcon(item: AndroidApp): string {
    if (!item.iconUrl) {
        return `<div class="app-icon-fallback" style="background: ${iconSeed(item.packageName)}">${shellEscapeText(initials(item.label))}</div>`;
    }
    return `
    <div class="app-icon-wrap">
      <img class="app-icon" src="${shellEscapeText(item.iconUrl)}" alt="" loading="lazy" draggable="false" />
    </div>
  `;
}

function updateBadgesFor(selector: string): void {
    document.querySelectorAll(selector).forEach(card => {
        const pkg = (card as HTMLElement).dataset.package;
        if (!pkg) return;
        const count = state.notificationCounts[pkg] || 0;
        let badge = card.querySelector(".notification-badge") as HTMLElement | null;
        if (count > 0) {
            if (badge) {
                badge.textContent = count > 99 ? "99+" : String(count);
            } else {
                badge = document.createElement("span");
                badge.className = "notification-badge";
                badge.textContent = count > 99 ? "99+" : String(count);
                const iconArea = card.querySelector(".app-icon-wrap, .app-icon-fallback");
                if (iconArea) iconArea.appendChild(badge);
            }
        } else {
            badge?.remove();
        }
    });
}

export function updateNotificationBadges(): void {
    updateBadgesFor(".app-card");
    updateBadgesFor(".modal-app-card");
}

export function highlightText(text: string, query: string): string {
    if (!query) return shellEscapeText(text);
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);
    if (index === -1) return shellEscapeText(text);

    const prefix = text.slice(0, index);
    const match = text.slice(index, index + query.length);
    const suffix = text.slice(index + query.length);

    return `${shellEscapeText(prefix)}<span class="highlight">${shellEscapeText(match)}</span>${shellEscapeText(suffix)}`;
}

export function createAppCardElement(item: AndroidApp): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "app-card";
    btn.draggable = true;
    btn.dataset.package = item.packageName;
    btn.dataset.launch = item.packageName;

    if (state.openApps.has(item.packageName)) {
        btn.classList.add("open");
    }
    if (isFavorited(item.packageName)) {
        btn.classList.add("favorite");
    }

    const message = state.launchMessages.get(item.packageName);
    if (message) {
        btn.classList.add("has-message", message.kind);
    }

    btn.innerHTML = `
    ${renderAppIcon(item)}
    <span class="app-name">${highlightText(item.label, state.query)}</span>
    ${message ? `<span class="launch-message">${shellEscapeText(message.text)}</span>` : ""}
  `;

    return btn;
}

export function updateCardElement(card: HTMLElement, item: AndroidApp): void {
    card.className = "app-card";
    if (state.openApps.has(item.packageName)) {
        card.classList.add("open");
    }
    if (isFavorited(item.packageName)) {
        card.classList.add("favorite");
    }

    const message = state.launchMessages.get(item.packageName);
    if (message) {
        card.classList.add("has-message", message.kind);
    }

    const nameEl = card.querySelector(".app-name");
    if (nameEl && nameEl.innerHTML !== highlightText(item.label, state.query)) {
        nameEl.innerHTML = highlightText(item.label, state.query);
    }

    const oldMsg = card.querySelector(".launch-message");
    if (oldMsg) oldMsg.remove();
    if (message) {
        const span = document.createElement("span");
        span.className = "launch-message";
        span.textContent = message.text;
        card.appendChild(span);
    }

    const iconArea = card.querySelector(".app-icon-wrap, .app-icon-fallback");
    if (iconArea) {
        const currentSrc = card.querySelector(".app-icon")?.getAttribute("src");
        if (currentSrc !== item.iconUrl) {
            iconArea.outerHTML = renderAppIcon(item);
        }
    }
}

export function updateOpenStatus(): void {
    const cards = document.querySelectorAll<HTMLElement>(".app-card");
    for (const card of cards) {
        const pkg = card.dataset.package;
        if (pkg) {
            if (state.openApps.has(pkg)) {
                card.classList.add("open");
            } else {
                card.classList.remove("open");
            }
        }
    }
}

export function openFolder(id: string | null): void {
    if (id === null) {
        state.currentFolderId = null;
        document.getElementById("folder-modal")?.classList.remove("open");
        return;
    }
    state.currentFolderId = id;
    const modal = document.getElementById("folder-modal");
    if (modal) {
        modal.classList.add("open");
        updateFolderModal();
    }
}

export function updateFolderModal(): void {
    const modal = document.getElementById("folder-modal");
    if (!modal) return;
    const content = modal.querySelector(".modal-content");
    if (!content) return;

    const id = state.currentFolderId;
    if (!id) return;

    let apps: AndroidApp[] = [];
    let title = "";

    const deviceFolders = state.folders[stableIdForSerial(state.selectedSerial)] ?? {};
    const folder = deviceFolders[id];
    if (folder) {
        title = folder.name;
        apps = id === "favorites"
            ? state.apps.filter(a => isFavorited(a.packageName))
            : state.apps.filter(a => folder.apps.includes(a.packageName));
    }

    content.innerHTML = `
        <div class="modal-head">
            <h2>${shellEscapeText(title)}</h2>
            <div class="modal-head-actions">
                ${id !== "favorites" ? `<button class="icon-button" id="deleteFolderBtn" title="Delete folder"><i data-lucide="trash-2"></i></button>` : ""}
                <button class="icon-button" id="closeFolderModal" title="Close"><i data-lucide="x"></i></button>
            </div>
        </div>
        <div class="modal-grid">
            ${apps.length > 0 
                ? apps.map(app => `
                    <div class="modal-app-card" draggable="true" data-package="${app.packageName}" data-launch="${app.packageName}">
                        ${renderAppIcon(app)}
                        <span>${shellEscapeText(app.label)}</span>
                    </div>
                `).join("")
                : '<p class="empty-msg">No apps in this folder</p>'
            }
        </div>
    `;
    renderIcons();
    updateNotificationBadges();
}

export function updateFocusedApp(): void {
    const cards = document.querySelectorAll<HTMLElement>(".app-card");
    cards.forEach((card, index) => {
        if (index === state.focusedAppIndex) {
            card.classList.add("focused");
        } else {
            card.classList.remove("focused");
        }
    });
}

export function createFolderElement(folder: Folder): HTMLElement {
    const div = document.createElement("div");
    div.className = "folder-card";
    div.dataset.folderId = folder.id;
    
    const apps = folder.id === "favorites"
        ? state.apps.filter(a => isFavorited(a.packageName))
        : state.apps.filter(a => folder.apps.includes(a.packageName));

    const previewIcons = apps.slice(0, 4).map(app => {
        const pkgAttr = `data-package="${shellEscapeText(app.packageName)}"`;
        return app.iconUrl 
            ? `<img src="${shellEscapeText(app.iconUrl)}" class="folder-preview-icon" draggable="false" ${pkgAttr} />`
            : `<div class="folder-preview-icon fallback" style="background: ${iconSeed(app.packageName)}" ${pkgAttr}></div>`;
    }).join("");

    const label = folder.name;
    
    div.innerHTML = `
      <div class="folder-preview">
        ${previewIcons}
        ${apps.length > 4 ? `<span class="folder-count">+${apps.length - 4}</span>` : ""}
      </div>
      <span class="folder-label">${shellEscapeText(label)}</span>
    `;
    div.onclick = () => openFolder(div.dataset.folderId ?? null);
    return div;
}

export function updateAppGrid(): void {
    const grid = document.querySelector<HTMLElement>("#appGrid");
    if (!grid) return;

    if (!state.selectedSerial) {
        const discoveredHtml = state.discoveredDevices.length > 0
            ? `<div class="discovered-devices">
              <h3>Devices on network</h3>
              ${state.discoveredDevices.filter((d, i, a) => a.findIndex(x => x.host === d.host && x.port === d.port) === i).map(d => {
                  const isTlsConnect = d.serviceType === "_adb-tls-connect._tcp";
                  const isTlsPairing = d.serviceType === "_adb-tls-pairing._tcp";
                  const label = isTlsConnect ? "Ready" : isTlsPairing ? "Pairing needed" : "Legacy";
                   return `<div class="discovered-device" data-host="${shellEscapeText(d.host)}" data-port="${d.port}" data-servicetype="${shellEscapeText(d.serviceType)}">
                     <div class="discovered-device-info">
                       <span class="discovered-device-addr">${shellEscapeText(d.host)}:${d.port}</span>
                       <span class="discovered-device-type ${isTlsConnect ? "ready" : isTlsPairing ? "pairing" : "legacy"}">${label}</span>
                     </div>
                     <div class="discovered-device-actions">
                       ${isTlsPairing ? `<button class="empty-button" data-pair-mdns="${shellEscapeText(d.host)}:${d.port}">Pair</button>` : ''}
                       <button class="empty-button" data-connect-mdns="${shellEscapeText(d.host)}:${d.port}">Connect</button>
                     </div>
                   </div>`;
              }).join("")}
            </div>`
            : state.scanningNetwork
                ? `<div class="discovered-devices scanning">
                    <p>Scanning network for ADB devices…</p>
                  </div>`
                : "";
        grid.innerHTML = `
      <section class="empty">
        <i data-lucide="monitor-smartphone"></i>
        <h2>Connect an Android device</h2>
        <p>Enable USB debugging, connect the device, and authorize this computer when Android asks.</p>
        <div class="empty-actions">
          <button class="empty-button primary" id="scanDevices">Scan for Devices</button>
          <button class="empty-button" id="showGuide">How to connect?</button>
        </div>
      </section>
      ${discoveredHtml}
    `;
        try {
            createIcons({ icons: { MonitorSmartphone } });
        } catch {}
        return;
    }

    if (state.loadingApps) {
        grid.innerHTML = `
      <section class="empty">
        <i data-lucide="refresh-cw"></i>
        <h2>Loading apps</h2>
        <p>Reading packages from ${shellEscapeText(state.selectedSerial)}.</p>
      </section>
    `;
        try {
            createIcons({ icons: { RefreshCw } });
        } catch {}
        return;
    }

    const apps = filteredApps();
    if (apps.length === 0) {
        grid.innerHTML = `
      <section class="empty">
        <i data-lucide="search"></i>
        <h2>No apps found</h2>
        <p>Try changing the search or enabling system apps in settings.</p>
        <div class="empty-actions">
          <button class="empty-button primary" id="clearSearch">Clear Search</button>
        </div>
      </section>
    `;
        try {
            createIcons({ icons: { Search } });
        } catch {}
        state.focusedAppIndex = null;
        return;
    }

    if (state.query.trim() !== "") {
        state.focusedAppIndex = 0;
    }

    const fragment = document.createDocumentFragment();

    const deviceFolders = state.folders[stableIdForSerial(state.selectedSerial)] ?? {};
    Object.values(deviceFolders).forEach(folder => {
        fragment.appendChild(createFolderElement(folder));
    });

    for (const item of apps) {
        fragment.appendChild(createAppCardElement(item));
    }

    grid.replaceChildren(fragment);
    updateFocusedApp();
    renderIcons();
    updateNotificationBadges();
}

export function updateControlRow(): void {
    const card = document.querySelector<HTMLElement>(".device-card.selected");
    if (card) {
        const device = selectedDevice();
        if (device) {
            const base = device.androidVersion
                ? `${device.model || device.serial} · Android ${device.androidVersion} · ${device.serial}`
                : device.serial;
            const queue = state.resolveQueue.size;
            card.title = `${base} · ${state.apps.length} apps${queue ? ` (resolving ${queue}…)` : ""}`;
        }
    }
    renderIcons();
}

export function updateStickyState(): void {
    const row = document.querySelector<HTMLElement>(".control-row");
    const topbar = document.querySelector<HTMLElement>(".titlebar");
    if (row && topbar) {
        row.classList.toggle(
            "stuck",
            topbar.getBoundingClientRect().bottom <= 0,
        );
    }
}

export function renderSettings(): string {
    if (!state.settings) return "";
    return `
        <p class="settings-desc">Point the launcher at your local Android tools.</p>
        <label class="field">
          <span>ADB path</span>
          <input id="adbPath" value="${shellEscapeText(state.settings.adbPath)}" placeholder="adb" />
        </label>
        <label class="field">
          <span>scrcpy path</span>
          <input id="scrcpyPath" value="${shellEscapeText(state.settings.scrcpyPath)}" placeholder="scrcpy" />
        </label>
        <label class="field">
          <span>Global scrcpy args</span>
          <input id="globalScrcpyArgs" value="${shellEscapeText(state.settings.globalScrcpyArgs)}" placeholder="e.g. --max-size 1024 --bit-rate 4M" />
          <small class="field-hint">Applied to all launches. Overridden by device/app args.</small>
        </label>

        <label class="check-row">
          <input id="includeSystemApps" type="checkbox" ${state.settings.includeSystemApps ? "checked" : ""} />
          <span>Show system packages</span>
        </label>

        <label class="check-row">
          <input id="flexDisplay" type="checkbox" ${state.settings.flexDisplay ? "checked" : ""} />
          <span>Flexible virtual display</span>
        </label>

        <label class="check-row">
          <input id="killOnClose" type="checkbox" ${state.settings.killOnClose ? "checked" : ""} />
          <span>Kill scrcpy windows on close</span>
        </label>

        <label class="field">
          <span>Virtual display bounds</span>
          <input id="displayBounds" value="${shellEscapeText(state.settings.displayBounds)}" placeholder="540x960" />
          <small class="field-hint">Leave empty for phone's native resolution</small>
        </label>

        ${
            state.devices.filter((d) => d.state === "device").length > 0
                ? `
          <details class="per-device-bounds">
            <summary>Per-device overrides</summary>
            ${state.devices
                .filter((d) => d.state === "device")
                .map((device) => {
                    const name = device.model || device.serial;
                    const val =
                        state.settings!.deviceDisplayBounds[device.serial] ||
                        "";
                    return `
                <label class="field device-bounds-row">
                  <span>${shellEscapeText(name)}</span>
                  <input class="device-bounds-input" data-serial="${shellEscapeText(device.serial)}" value="${shellEscapeText(val)}" placeholder="Inherit global" />
                </label>
              `;
                })
                .join("")}
          </details>
        `
                : ""
        }

        <label class="field">
          <span>Icon source</span>
          <select id="iconSource">
            <option value="none" ${state.settings.iconSource === "none" ? "selected" : ""}>Generated placeholders</option>
            <option value="web" ${state.settings.iconSource === "web" ? "selected" : ""}>Google Play metadata</option>
          </select>
        </label>

        ${
            state.wirelessDevices.length > 0
                ? `
        <details class="wireless-devices-section">
          <summary>Saved wireless devices</summary>
          <div class="wireless-device-list">
            ${state.wirelessDevices
                .map(
                    (addr) =>
                        `<div class="wireless-device-item">
              <span class="wireless-device-addr">${shellEscapeText(addr)}</span>
              <div class="wireless-device-actions">
                <button class="icon-button tiny" data-reconnect="${shellEscapeText(addr)}" title="Reconnect"><i data-lucide="wifi"></i></button>
                <button class="icon-button tiny" data-disconnect-wireless="${shellEscapeText(addr)}" title="Remove"><i data-lucide="trash-2"></i></button>
              </div>
            </div>`,
                )
                .join("")}
          </div>
        </details>
      `
                : ""
        }

        <div class="install-help">
          <h3>Dependencies</h3>
          <p><strong>adb</strong> — Android Debug Bridge. Install <code>android-tools</code> (Linux), <code>brew install android-platform-tools</code> (macOS), or platform-tools from Google (Windows).</p>
          <p><strong>scrcpy</strong> — screen copy for Android. Install from your distro (Linux), Scoop/Chocolatey (Windows), or <code>brew install scrcpy</code> (macOS).</p>
          <p><strong>kdotool</strong> — required for window focus on KDE Wayland. Install with <code>cargo install kdotool</code>.</p>
          <p><strong>xdotool</strong> — used as fallback on X11. Install <code>xdotool</code> from your distro (Linux).</p>
        </div>
  `;
}

export function renderIcons() {
    try {
        createIcons({
            icons: {
                Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium,
                ChevronDown, Download, MonitorSmartphone, Play, RefreshCw, Search,
                Server, Settings, Smartphone, Trash2, Usb, Wifi, X, Upload,
            },
        });
    } catch (error) {
        console.warn("Unable to render lucide icons", error);
    }
}

export function updateDeviceDropdown(): void {
    const container = document.getElementById("top-actions");
    if (!container) return;
    const existing = container.querySelector(".device-pill, .device-chip");
    if (existing) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = renderDeviceSelect();
        const replacement = wrapper.firstElementChild;
        if (replacement) {
            existing.replaceWith(replacement);
            renderIcons();
        }
    }
}

export function updateTopBar(): void {
    const container = document.getElementById("top-actions");
    if (!container) return;
    container.innerHTML = `
        ${state.tools ? renderStatusPill(state.tools.adb, "ADB") + renderStatusPill(state.tools.scrcpy, "scrcpy") : ""}
        ${renderDeviceSelect()}
        <button class="icon-button" id="adbRestart" title="Restart ADB server"><i data-lucide="server"></i></button>
        <button class="icon-button" id="wirelessConnect" title="Connect wireless ADB device"><i data-lucide="wifi"></i></button>
        <button class="icon-button" id="installApk" title="Install APK"><i data-lucide="upload"></i></button>
        <button class="icon-button" id="reload" title="Rescan apps and devices"><i data-lucide="refresh-cw"></i></button>
        <button class="icon-button" id="settings" title="Settings"><i data-lucide="settings"></i></button>
    `;
    renderIcons();
    updateControlRow();
}

export function updateWirelessForm(): void {
    const container = document.getElementById("wireless-container");
    if (!container) return;
    container.innerHTML = state.wirelessConnectOpen ? renderWirelessForm() : "";
    renderIcons();
}

let errorClearTimer: ReturnType<typeof setTimeout> | null = null;

export function updateErrorBanner(): void {
    const container = document.getElementById("error-container");
    if (!container) return;
    container.innerHTML = state.error ? `<div class="error-banner">${shellEscapeText(state.error)}</div>` : "";
    if (errorClearTimer) {
        clearTimeout(errorClearTimer);
        errorClearTimer = null;
    }
    if (state.error) {
        errorClearTimer = setTimeout(() => {
            state.error = "";
            updateErrorBanner();
        }, 5000);
    }
}

export function updateSettings(): void {
    const panel = document.getElementById("settings-panel");
    const scrim = document.getElementById("closeSettings");
    const scroll = document.getElementById("settings-scroll");
    if (!panel || !scrim || !scroll) return;
    if (state.settingsOpen && state.settings) {
        scroll.innerHTML = renderSettings();
        panel.classList.add("open");
        scrim.classList.add("open");
    } else {
        panel.classList.remove("open");
        scrim.classList.remove("open");
    }
    renderIcons();
}

export function showConnectionGuide(): void {
    document.getElementById("guide-modal")?.classList.add("open");
}

export function renderContextMenu(): void {
    const menu = document.getElementById("context-menu");
    if (!menu) return;

    if (!state.contextMenu) {
        menu.style.display = "none";
        return;
    }

    const { x, y, pkg, folderId, folderName, deviceStableId } = state.contextMenu;
    menu.style.display = "block";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.transform = "none";
    const { offsetWidth, offsetHeight } = menu;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const flipX = x + offsetWidth > vw;
    const flipY = y + offsetHeight > vh;
    if (flipX) menu.style.left = `${Math.max(4, x - offsetWidth)}px`;
    if (flipY) menu.style.top = `${Math.max(4, y - offsetHeight)}px`;

    // Device-level context menu (right-click on a device pill)
    if (deviceStableId) {
        menu.innerHTML = `
        <div class="menu-group">
            <div class="menu-item" data-action="rename-device" data-stable-id="${shellEscapeText(deviceStableId)}">
                <span>Rename device</span>
            </div>
            <div class="menu-item" data-action="set-device-args" data-stable-id="${shellEscapeText(deviceStableId)}">
                <span>Scrcpy args</span>
            </div>
        </div>`;
        return;
    }

    // Folder-level context menu (right-click on a folder card)
    if (folderId && !pkg) {
        menu.innerHTML = `
        <div class="menu-group">
            <div class="menu-item" data-action="rename-folder" data-folder-id="${shellEscapeText(folderId)}" data-folder-name="${shellEscapeText(folderName ?? "")}">
                <span>Rename</span>
            </div>
            <div class="menu-item" data-action="delete-folder" data-folder-id="${shellEscapeText(folderId)}">
                <span>Delete ${shellEscapeText(folderName ?? "folder")}</span>
            </div>
        </div>`;
        return;
    }

    if (!pkg) return;

    const inFolder = state.currentFolderId && state.currentFolderId !== "favorites";
    const deviceFolders = state.folders[stableIdForSerial(state.selectedSerial)] ?? {};
    const folders = Object.values(deviceFolders);
    const folderOptions = folders
        .filter(f => f.id !== "favorites")
        .map(f => `
        <div class="menu-item" data-action="add-to-folder" data-folder-id="${f.id}" data-pkg="${shellEscapeText(pkg)}">
            <span>Add to ${shellEscapeText(f.name)}</span>
        </div>
    `).join("");

    const isFav = isFavorited(pkg);

    const parts: string[] = [];
    parts.push(`<div class="menu-group">`);
    parts.push(`<div class="menu-item" data-action="add-to-folder" data-folder-id="favorites" data-pkg="${shellEscapeText(pkg)}">`);
    parts.push(`<span>${isFav ? "Remove from" : "Add to"} Favorites</span>`);
    parts.push(`</div>`);
    if (inFolder) {
        parts.push(`<div class="menu-item" data-action="remove-from-folder" data-folder-id="${shellEscapeText(state.currentFolderId!)}" data-pkg="${shellEscapeText(pkg)}">`);
        parts.push(`<span>Remove from this folder</span>`);
        parts.push(`</div>`);
    }
    parts.push(`</div>`);
    parts.push(`<div class="menu-group">`);
    parts.push(`<div class="menu-item" data-action="set-app-args" data-pkg="${shellEscapeText(pkg)}">`);
    parts.push(`<span>Scrcpy args</span>`);
    parts.push(`</div>`);
    parts.push(`<div class="menu-item" data-action="create-folder" data-pkg="${shellEscapeText(pkg)}">`);
    parts.push(`<span>Create New Folder</span>`);
    parts.push(`</div>`);
    parts.push(folderOptions);
    parts.push(`</div>`);

    menu.innerHTML = parts.join("");
}

export function openCreateFolderModal(pkg: string): void {
    state.createFolderPkg = pkg;
    const modal = document.getElementById("create-folder-modal");
    if (!modal) return;
    modal.classList.add("open");
    const input = document.getElementById("createFolderName") as HTMLInputElement;
    if (input) {
        input.value = "";
        input.focus();
    }
}

export function closeCreateFolderModal(): void {
    state.createFolderPkg = "";
    document.getElementById("create-folder-modal")?.classList.remove("open");
}

export function openRenameDeviceModal(stableId: string): void {
    state.renameDeviceStableId = stableId;
    const modal = document.getElementById("rename-device-modal");
    if (!modal) return;
    modal.classList.add("open");
    const input = document.getElementById("renameDeviceName") as HTMLInputElement;
    if (input) {
        input.value = state.settings?.deviceNicknames?.[stableId] ?? "";
        input.focus();
    }
}

export function closeRenameDeviceModal(): void {
    state.renameDeviceStableId = "";
    document.getElementById("rename-device-modal")?.classList.remove("open");
}

export function openRenameFolderModal(folderId: string, folderName: string): void {
    state.renameFolderId = folderId;
    state.renameFolderName = folderName;
    const modal = document.getElementById("rename-folder-modal");
    if (!modal) return;
    modal.classList.add("open");
    const input = document.getElementById("renameFolderName") as HTMLInputElement;
    if (input) {
        input.value = folderName;
        input.focus();
        input.select();
    }
}

export function closeRenameFolderModal(): void {
    state.renameFolderId = "";
    state.renameFolderName = "";
    document.getElementById("rename-folder-modal")?.classList.remove("open");
}

export function openScrcpyArgsModal(id: string, type: "device" | "app", currentArgs: string): void {
    state.scrcpyArgsId = id;
    state.scrcpyArgsType = type;
    state.scrcpyArgsValue = currentArgs;
    const modal = document.getElementById("scrcpy-args-modal");
    if (!modal) return;
    modal.classList.add("open");
    const input = document.getElementById("scrcpyArgsInput") as HTMLInputElement;
    if (input) {
        input.value = currentArgs;
        input.focus();
        input.select();
    }
}

export function closeScrcpyArgsModal(): void {
    state.scrcpyArgsId = "";
    state.scrcpyArgsType = null;
    state.scrcpyArgsValue = "";
    document.getElementById("scrcpy-args-modal")?.classList.remove("open");
}

export function openPairingModal(hostPort: string): void {
    state.pairingHostPort = hostPort;
    state.pairingCode = "";
    const modal = document.getElementById("pairing-modal");
    if (!modal) return;
    modal.classList.add("open");
    const input = document.getElementById("pairingCode") as HTMLInputElement;
    if (input) {
        input.value = "";
        input.focus();
    }
}

export function closePairingModal(): void {
    state.pairingHostPort = "";
    state.pairingCode = "";
    document.getElementById("pairing-modal")?.classList.remove("open");
}

export function initShell(): void {
    const app = document.querySelector<HTMLDivElement>("#app")!;
    app.innerHTML = `
    <main class="shell" id="app-shell" tabindex="-1">
      <header class="titlebar" data-tauri-drag-region>
        <div class="brand">
          <div class="brand-mark"><img src="/app-icon.png" class="brand-icon" alt="" /></div>
          <div>
            <h1>scrcpy Launcher <span class="version-badge">v${version}</span></h1>
          </div>
        </div>
        <div class="titlebar-controls">
          <button class="titlebar-btn" id="titlebarMinimize" title="Minimize"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
          <button class="titlebar-btn" id="titlebarMaximize" title="Maximize"><svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke="currentColor" stroke-width="1.5"/></svg></button>
          <button class="titlebar-btn" id="titlebarClose" title="Close"><svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
      </header>

      <div id="wireless-container"></div>

      <section class="control-row">
        <div class="top-actions" id="top-actions"></div>
        <label class="search-box">
          <i data-lucide="search"></i>
          <input id="search" value="${shellEscapeText(state.query)}" placeholder="Search apps or packages" autocomplete="off" />
        </label>
      </section>

      <div id="error-container"></div>
      <div id="context-menu" class="context-menu"></div>
      <section id="appGrid" class="app-grid"></section>

      <div class="scrim" id="closeSettings"></div>
      <aside class="settings-panel" id="settings-panel" aria-label="Settings">
        <div class="panel-head">
          <h2>Settings</h2>
          <button class="icon-button" id="settingsX" title="Close settings"><i data-lucide="x"></i></button>
        </div>
        <div class="settings-scroll" id="settings-scroll"></div>
        <button class="primary-button" id="saveSettings">Save settings</button>
      </aside>

      <div id="folder-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content"></div>
      </div>

      <div id="create-folder-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>Create Folder</h2>
            <button class="icon-button" id="closeCreateFolder" title="Cancel"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <label class="create-folder-label">Folder name</label>
            <input id="createFolderName" class="create-folder-input" placeholder="My Folder" autocomplete="off" />
            <div class="create-folder-actions">
              <button class="empty-button" id="cancelCreateFolder">Cancel</button>
              <button class="empty-button primary" id="confirmCreateFolder">Create</button>
            </div>
          </div>
        </div>
      </div>

      <div id="rename-device-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>Rename device</h2>
            <button class="icon-button" id="closeRenameDevice" title="Cancel"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <label class="create-folder-label">Device nickname</label>
            <input id="renameDeviceName" class="create-folder-input" placeholder="e.g. My Phone" autocomplete="off" />
            <div class="create-folder-actions">
              <button class="empty-button" id="cancelRenameDevice">Cancel</button>
              <button class="empty-button primary" id="confirmRenameDevice">Rename</button>
            </div>
          </div>
        </div>
      </div>

      <div id="rename-folder-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>Rename folder</h2>
            <button class="icon-button" id="closeRenameFolder" title="Cancel"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <label class="create-folder-label">Folder name</label>
            <input id="renameFolderName" class="create-folder-input" placeholder="Folder name" autocomplete="off" />
            <div class="create-folder-actions">
              <button class="empty-button" id="cancelRenameFolder">Cancel</button>
              <button class="empty-button primary" id="confirmRenameFolder">Rename</button>
            </div>
          </div>
        </div>
      </div>

      <div id="scrcpy-args-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>Scrcpy arguments</h2>
            <button class="icon-button" id="closeScrcpyArgs" title="Cancel"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <label class="create-folder-label">Arguments</label>
            <input id="scrcpyArgsInput" class="create-folder-input" placeholder="e.g. --max-size 1024 --bit-rate 4M" autocomplete="off" />
            <div class="create-folder-actions">
              <button class="empty-button" id="cancelScrcpyArgs">Cancel</button>
              <button class="empty-button primary" id="confirmScrcpyArgs">Save</button>
            </div>
          </div>
        </div>
      </div>

      <div id="pairing-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>ADB Pairing</h2>
            <button class="icon-button" id="closePairing" title="Cancel"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <label class="create-folder-label">Pairing code</label>
            <input id="pairingCode" class="create-folder-input" placeholder="Enter 6-digit code" autocomplete="off" />
            <div class="create-folder-actions">
              <button class="empty-button" id="cancelPairing">Cancel</button>
              <button class="empty-button primary" id="confirmPairing">Pair</button>
            </div>
          </div>
        </div>
      </div>

      <div id="update-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content" style="max-width:400px">
          <div class="modal-head">
            <h2>Update available</h2>
            <button class="icon-button" id="closeUpdateModal" title="Dismiss"><i data-lucide="x"></i></button>
          </div>
          <div class="create-folder-body">
            <p style="color:#aeb4bc;margin:0;line-height:1.5" id="updateMessage">A new version is available.</p>
            <div class="create-folder-actions">
              <button class="empty-button" id="ignoreUpdate">Ignore this version</button>
              <a class="empty-button primary" id="downloadUpdate" href="https://github.com/richardred15/scrcpy-launcher/releases/latest" target="_blank" style="text-decoration:none">Download</a>
            </div>
          </div>
        </div>
      </div>

      <div id="guide-modal" class="folder-modal">
        <div class="modal-overlay"></div>
        <div class="modal-content">
          <div class="modal-head">
            <h2>Connection Guide</h2>
            <button class="icon-button" id="closeGuideModal" title="Close"><i data-lucide="x"></i></button>
          </div>
          <div class="guide-body">
            <ol class="guide-list">
              <li>Go to <strong>Settings</strong> &gt; <strong>About Phone</strong></li>
              <li>Tap <strong>Build Number</strong> 7 times to enable Developer Options</li>
              <li>Go to <strong>Settings</strong> &gt; <strong>System</strong> &gt; <strong>Developer Options</strong></li>
              <li>Enable <strong>USB Debugging</strong></li>
              <li>Connect your phone to this PC via USB</li>
              <li>
                Accept the RSA authorization prompt on your phone screen
                <br/><small>If no prompt appears, check your phone's notification panel. You may need to reconnect the USB cable or go to Developer Options &gt; Revoke USB debugging authorizations and retry.</small>
              </li>
            </ol>
            <div id="scrcpy-win-download" style="display:none">
              <hr />
              <button class="empty-button primary" id="installScrcpyWindows">
                <i data-lucide="download"></i> Download scrcpy + ADB for Windows
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  `;
    
    const shell = document.getElementById("app-shell");
    if (shell) {
        shell.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
            shell.focus();
        });
    }

    renderIcons();
    const winDownload = document.getElementById("scrcpy-win-download");
    if (winDownload) {
        winDownload.style.display = navigator.userAgent.includes("Windows") ? "" : "none";
    }
    updateTopBar();
    updateWirelessForm();
    updateErrorBanner();
    updateSettings();
    updateAppGrid();
    updateStickyState();
}
