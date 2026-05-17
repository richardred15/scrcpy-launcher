import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    createIcons,
    Battery,
    BatteryCharging,
    BatteryFull,
    BatteryLow,
    BatteryMedium,
    Cable,
    MonitorSmartphone,
    Play,
    RefreshCw,
    Search,
    Settings,
    Smartphone,
    Wifi,
    X,
} from "lucide";
import "./styles.css";

type SettingsState = {
    adbPath: string;
    scrcpyPath: string;
    includeSystemApps: boolean;
    iconSource: "web" | "none";
    flexDisplay: boolean;
    webEnabled: boolean;
    adbFallback: boolean;
    killOnClose: boolean;
    displayBounds: string;
    deviceDisplayBounds: Record<string, string>;
};

type BinaryStatus = {
    path: string;
    found: boolean;
    version?: string;
    help: string;
};

type ToolStatus = {
    adb: BinaryStatus;
    scrcpy: BinaryStatus;
};

type Device = {
    serial: string;
    state: string;
    model?: string;
    androidVersion?: string;
    batteryLevel?: number;
    batteryTemperature?: number;
    batteryCharging?: boolean;
    wireless: boolean;
};

type AndroidApp = {
    packageName: string;
    activity?: string;
    label: string;
    iconUrl?: string;
};

type LaunchResult = {
    usedFlexDisplay: boolean;
    message?: string;
};

type AppMetaResolvedEvent = {
    packageName: string;
    label: string;
    iconUrl: string | null;
};

type CachedAppMeta = {
    label: string;
    iconDataUrl: string | null;
    source: string;
    resolvedAt: number;
};

type AppsLoadedEvent = {
    serial: string;
    apps: AndroidApp[];
};

const state = {
    settings: null as SettingsState | null,
    tools: null as ToolStatus | null,
    devices: [] as Device[],
    selectedSerial: "",
    apps: [] as AndroidApp[],
    cacheMeta: null as Map<string, CachedAppMeta> | null,
    resolveQueue: new Set<string>(),
    appLoadToken: 0,
    // device state driven by events from background worker
    lastReadyDeviceKey: "",
    query: "",
    loadingDevices: true,
    loadingApps: false,
    loadingIcons: false,
    settingsOpen: false,
    error: "",
    wirelessConnectOpen: false,
    wirelessHostPort: "",
    wirelessConnecting: false,
    wirelessDevices: [] as string[],
    openApps: new Set<string>(),
    launchingPackage: "",
    launchMessages: new Map<string, { kind: "info" | "error"; text: string }>(),
};

const app = document.querySelector<HTMLDivElement>("#app")!;

window.addEventListener("error", (event) => {
    state.error = event.message || "A frontend error occurred.";
    updateErrorBanner();
});

window.addEventListener("unhandledrejection", (event) => {
    state.error = String(event.reason || "An async frontend error occurred.");
    updateErrorBanner();
});

function iconSeed(packageName: string): string {
    let hash = 0;
    for (const char of packageName)
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    return `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 70% 38%))`;
}

function initials(label: string): string {
    return (
        label
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || "?"
    );
}

function prettyLabel(packageName: string): string {
    const tail = packageName.split(".").pop() || packageName;
    return tail.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function selectedDevice(): Device | undefined {
    return state.devices.find(
        (device) => device.serial === state.selectedSerial,
    );
}

function filteredApps(): AndroidApp[] {
    const query = state.query.trim().toLowerCase();
    if (!query) return state.apps;
    return state.apps.filter((item) => {
        return (
            item.label.toLowerCase().includes(query) ||
            item.packageName.toLowerCase().includes(query)
        );
    });
}

function shellEscapeText(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        const map: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;",
        };
        return map[char];
    });
}

function renderStatusPill(binary: BinaryStatus, label: string): string {
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

function renderDeviceSelect(): string {
    if (state.loadingDevices) {
        return `<div class="device-chip muted"><i data-lucide="refresh-cw"></i><span>Finding devices</span></div>`;
    }

    if (state.devices.length === 0) {
        return `<div class="device-chip warning"><i data-lucide="cable"></i><span>No devices</span></div>`;
    }

    if (state.devices.length === 1) {
        const device = state.devices[0];
        const name = device.model || device.serial;
        const wirelessIcon = device.wireless
            ? `<i data-lucide="wifi" class="device-wifi"></i>`
            : "";
        const disconnectBtn = device.wireless
            ? `<button class="icon-button tiny" data-disconnect="${shellEscapeText(device.serial)}" title="Disconnect"><i data-lucide="x"></i></button>`
            : "";
        return `<button type="button" class="device-chip clickable" title="${shellEscapeText(`${name} · ${device.serial}`)}"><i data-lucide="smartphone"></i><span>${shellEscapeText(name)}</span>${wirelessIcon}${disconnectBtn}</button>`;
    }

    return `
    <label class="device-select">
      <i data-lucide="smartphone"></i>
      <select id="deviceSelect" aria-label="Select Android device">
        ${state.devices
            .map((device) => {
                const name = `${device.model || device.serial}${device.androidVersion ? ` · Android ${device.androidVersion}` : ""}`;
                const wirelessIcon = device.wireless
                    ? `<i data-lucide="wifi" class="device-wifi"></i>`
                    : "";
                const disconnectBtn = device.wireless
                    ? `<button class="icon-button tiny" data-disconnect="${shellEscapeText(device.serial)}" title="Disconnect" onclick="event.stopPropagation()"><i data-lucide="x"></i></button>`
                    : "";
                return `<option value="${shellEscapeText(device.serial)}" ${device.serial === state.selectedSerial ? "selected" : ""}>${shellEscapeText(name)}${wirelessIcon}</option>`;
            })
            .join("")}
      </select>
      ${state.devices
          .filter((d) => d.wireless)
          .map(
              (device) =>
                  `<button class="icon-button tiny" data-disconnect="${shellEscapeText(device.serial)}" title="Disconnect"><i data-lucide="x"></i></button>`,
          )
          .join("")}
    </label>
  `;
}

function renderBatteryPill(): string {
    const device = selectedDevice();
    if (!device || device.batteryLevel === undefined) return "";
    const icon = batteryIcon(device.batteryLevel);
    const charging = device.batteryCharging
        ? `<i data-lucide="battery-charging"></i>`
        : "";
    return `<div class="pill" title="Battery">${icon} ${device.batteryLevel}% ${charging}</div>`;
}

function renderTempPill(): string {
    const device = selectedDevice();
    if (!device || device.batteryTemperature === undefined) return "";
    const temp = device.batteryTemperature;
    return `<div class="pill" title="Temperature">${temp.toFixed(1)}°C</div>`;
}

function renderWirelessForm(): string {
    return `
    <div class="wireless-form">
      <input id="wirelessHostPort" value="${shellEscapeText(state.wirelessHostPort)}" placeholder="host:port" autocomplete="off" ${state.wirelessConnecting ? "disabled" : ""} />
      <button class="primary-button small" id="doWirelessConnect" ${state.wirelessConnecting ? "disabled" : ""}>${state.wirelessConnecting ? "Connecting…" : "Connect"}</button>
      <span class="wireless-close" id="closeWirelessForm">&times;</span>
    </div>
  `;
}

function renderAppIcon(item: AndroidApp): string {
    if (!item.iconUrl) {
        return `<div class="app-icon-fallback" style="background: ${iconSeed(item.packageName)}">${shellEscapeText(initials(item.label))}</div>`;
    }
    return `
    <div class="app-icon-wrap">
      <img class="app-icon" src="${shellEscapeText(item.iconUrl)}" alt="" loading="lazy" />
    </div>
  `;
}

function createAppCardElement(item: AndroidApp): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "app-card";
    btn.dataset.package = item.packageName;
    btn.dataset.launch = item.packageName;

    if (state.openApps.has(item.packageName)) {
        btn.classList.add("open");
    }

    const message = state.launchMessages.get(item.packageName);
    if (message) {
        btn.classList.add("has-message", message.kind);
    }

    const showPackage = item.label === prettyLabel(item.packageName);

    btn.innerHTML = `
    ${renderAppIcon(item)}
    <span class="app-name">${shellEscapeText(item.label)}</span>
    ${showPackage ? `<span class="package-name">${shellEscapeText(item.packageName)}</span>` : ""}
    ${message ? `<span class="launch-message">${shellEscapeText(message.text)}</span>` : ""}
  `;

    return btn;
}

function updateCardElement(card: HTMLElement, item: AndroidApp): void {
    card.className = "app-card";
    if (state.openApps.has(item.packageName)) {
        card.classList.add("open");
    }

    const message = state.launchMessages.get(item.packageName);
    if (message) {
        card.classList.add("has-message", message.kind);
    }

    const nameEl = card.querySelector(".app-name");
    if (nameEl && nameEl.textContent !== item.label) {
        nameEl.textContent = item.label;
    }

    const showPackage = item.label === prettyLabel(item.packageName);
    const pkgEl = card.querySelector(".package-name");
    if (showPackage) {
        if (!pkgEl) {
            const span = document.createElement("span");
            span.className = "package-name";
            span.textContent = item.packageName;
            nameEl?.after(span);
        } else if (pkgEl.textContent !== item.packageName) {
            pkgEl.textContent = item.packageName;
        }
    } else {
        pkgEl?.remove();
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

function updateOpenStatus(): void {
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

function updateAppGrid(): void {
    const grid = document.querySelector<HTMLElement>("#appGrid");
    if (!grid) return;

    const device = selectedDevice();

    if (!device && state.devices.length === 0) {
        grid.innerHTML = `
      <section class="empty">
        <i data-lucide="monitor-smartphone"></i>
        <h2>Connect an Android device</h2>
        <p>Enable USB debugging, connect the device, and authorize this computer when Android asks.</p>
      </section>
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
      </section>
    `;
        try {
            createIcons({ icons: { Search } });
        } catch {}
        return;
    }

    const existingMap = new Map<string, HTMLElement>();
    for (const child of [...grid.children]) {
        const el = child as HTMLElement;
        const pkg = el.dataset.package;
        if (pkg) existingMap.set(pkg, el);
    }

    const fragment = document.createDocumentFragment();
    for (const item of apps) {
        const existing = existingMap.get(item.packageName);
        if (existing) {
            updateCardElement(existing, item);
            fragment.appendChild(existing);
            existingMap.delete(item.packageName);
        } else {
            fragment.appendChild(createAppCardElement(item));
        }
    }

    for (const [, el] of existingMap) {
        el.remove();
    }

    grid.replaceChildren(fragment);
}

function updateControlRow(): void {
    const chip = document.querySelector<HTMLElement>(
        ".device-chip:not(.muted):not(.warning)",
    );
    if (chip) {
        const device = selectedDevice();
        if (device) {
            const base = device.androidVersion
                ? `${device.model || device.serial} · Android ${device.androidVersion} · ${device.serial}`
                : device.serial;
            const queue = state.resolveQueue.size;
            chip.title = `${base} · ${state.apps.length} apps${queue ? ` (resolving ${queue}…)` : ""}`;
        }
    }
    const selectWrap = document.querySelector<HTMLElement>(".device-select");
    if (selectWrap) {
        const device = selectedDevice();
        if (device) {
            const queue = state.resolveQueue.size;
            selectWrap.title = `${state.apps.length} apps${queue ? ` (resolving ${queue}…)` : ""}`;
        }
    }
}

function updateStickyState(): void {
    const row = document.querySelector<HTMLElement>(".control-row");
    const topbar = document.querySelector<HTMLElement>(".topbar");
    if (row && topbar) {
        row.classList.toggle(
            "stuck",
            topbar.getBoundingClientRect().bottom <= 0,
        );
    }
}

function renderSettings(): string {
    if (!state.settings || !state.settingsOpen) return "";
    return `
    <div class="scrim" id="closeSettings"></div>
    <aside class="settings-panel" aria-label="Settings">
      <div class="panel-head">
        <div>
          <h2>Settings</h2>
          <p>Point the launcher at your local Android tools.</p>
        </div>
        <button class="icon-button" id="settingsX" title="Close settings"><i data-lucide="x"></i></button>
      </div>

      <div class="settings-scroll">
        <label class="field">
          <span>ADB path</span>
          <input id="adbPath" value="${shellEscapeText(state.settings.adbPath)}" placeholder="adb" />
        </label>
        <label class="field">
          <span>scrcpy path</span>
          <input id="scrcpyPath" value="${shellEscapeText(state.settings.scrcpyPath)}" placeholder="scrcpy" />
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
      </div>

      <button class="primary-button" id="saveSettings">Save settings</button>
    </aside>
  `;
}

function renderIcons() {
    try {
        createIcons({
            icons: {
                Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium,
                Cable, MonitorSmartphone, Play, RefreshCw, Search, Settings,
                Smartphone, Wifi, X,
            },
        });
    } catch (error) {
        console.warn("Unable to render lucide icons", error);
    }
}

function updateShellDeviceSerial(): void {
    const el = document.getElementById("shell-device-serial");
    if (!el) return;
    const device = selectedDevice();
    el.textContent = device ? device.serial : "Android apps as desktop windows";
}

function updateTopBar(): void {
    const container = document.getElementById("top-actions");
    if (!container) return;
    container.innerHTML = `
        ${state.tools ? renderStatusPill(state.tools.adb, "ADB") + renderStatusPill(state.tools.scrcpy, "scrcpy") : ""}
        ${renderDeviceSelect()}
        ${renderBatteryPill()}
        ${renderTempPill()}
        <button class="icon-button" id="wirelessConnect" title="Connect wireless ADB device"><i data-lucide="wifi"></i></button>
        <button class="icon-button" id="reload" title="Rescan apps and devices"><i data-lucide="refresh-cw"></i></button>
        <button class="icon-button" id="settings" title="Settings"><i data-lucide="settings"></i></button>
    `;
    renderIcons();
    updateControlRow();
}

function updateWirelessForm(): void {
    const container = document.getElementById("wireless-container");
    if (!container) return;
    container.innerHTML = state.wirelessConnectOpen ? renderWirelessForm() : "";
    renderIcons();
}

function updateErrorBanner(): void {
    const container = document.getElementById("error-container");
    if (!container) return;
    container.innerHTML = state.error ? `<div class="error-banner">${shellEscapeText(state.error)}</div>` : "";
}

function updateSettings(): void {
    const container = document.getElementById("settings-container");
    if (!container) return;
    container.innerHTML = renderSettings();
    renderIcons();
}

function initShell(): void {
    app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"><img src="/app-icon.png" class="brand-icon" alt="" /></div>
          <div>
            <h1>scrcpy Launcher</h1>
            <p id="shell-device-serial">Android apps as desktop windows</p>
          </div>
        </div>
        <div class="top-actions" id="top-actions"></div>
      </header>

      <div id="wireless-container"></div>

      <section class="control-row">
        <label class="search-box">
          <i data-lucide="search"></i>
          <input id="search" value="${shellEscapeText(state.query)}" placeholder="Search apps or packages" autocomplete="off" />
        </label>
      </section>

      <div id="error-container"></div>
      <section id="appGrid" class="app-grid"></section>
      <div id="settings-container"></div>
    </main>
  `;
    renderIcons();
    updateShellDeviceSerial();
    updateTopBar();
    updateWirelessForm();
    updateErrorBanner();
    updateSettings();
    updateAppGrid();
    updateStickyState();
}

function setupEventDelegation(): void {
    app.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;

        if (target.closest("#settings")) {
            state.settingsOpen = true;
            updateSettings();
            return;
        }

        if (target.closest("#settingsX") || target.closest("#closeSettings")) {
            closeSettings();
            return;
        }

        if (target.closest("#wirelessConnect")) {
            state.wirelessConnectOpen = !state.wirelessConnectOpen;
            state.wirelessHostPort = "";
            state.wirelessConnecting = false;
            updateWirelessForm();
            if (state.wirelessConnectOpen) {
                setTimeout(
                    () => document.getElementById("wirelessHostPort")?.focus(),
                    0,
                );
            }
            return;
        }

        if (target.closest("#closeWirelessForm")) {
            state.wirelessConnectOpen = false;
            updateWirelessForm();
            return;
        }

        if (target.closest("#doWirelessConnect") && !state.wirelessConnecting) {
            void doWirelessConnect();
            return;
        }

        if (target.closest("#reload")) {
            void refreshAll();
            return;
        }

        const disconnectBtn = target.closest("[data-disconnect]");
        if (disconnectBtn) {
            const serial = (disconnectBtn as HTMLElement).dataset.disconnect!;
            const device = state.devices.find((d) => d.serial === serial);
            if (device && device.wireless) {
                void doWirelessDisconnect(serial);
            }
            return;
        }

        const reconnectBtn = target.closest("[data-reconnect]");
        if (reconnectBtn) {
            const addr = (reconnectBtn as HTMLElement).dataset.reconnect!;
            void doWirelessReconnect(addr);
            return;
        }

        const disconnectWirelessBtn = target.closest("[data-disconnect-wireless]");
        if (disconnectWirelessBtn) {
            const addr = (disconnectWirelessBtn as HTMLElement).dataset.disconnectWireless!;
            void doWirelessDisconnect(addr);
            return;
        }

        const chip = target.closest(".device-chip:not(.muted):not(.warning)");
        if (chip) {
            const device = selectedDevice();
            if (device) void launchMirror(device.serial);
            return;
        }

        const card = target.closest("[data-launch]");
        if (card) {
            const packageName = (card as HTMLElement).dataset.launch!;
            const item = state.apps.find((a) => a.packageName === packageName);
            if (item) void launch(item);
            return;
        }

        if (target.closest("#saveSettings")) {
            void saveSettings();
            return;
        }
    });

    app.addEventListener("change", (event) => {
        const select = event.target as HTMLSelectElement;
        if (select.id === "deviceSelect") {
            state.selectedSerial = select.value;
            beginLoadApps(state.selectedSerial);
        }
    });

    app.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input.id === "search") {
            state.query = input.value;
            updateAppGrid();
        }
        if (input.id === "wirelessHostPort") {
            state.wirelessHostPort = input.value;
        }
    });

    app.addEventListener("keydown", (event) => {
        if (
            (event as KeyboardEvent).key === "Enter" &&
            state.wirelessConnectOpen &&
            !state.wirelessConnecting
        ) {
            const input = document.getElementById("wirelessHostPort");
            if (input && document.activeElement === input) {
                void doWirelessConnect();
            }
        }
    });

    app.addEventListener("error", (event) => {
        const img = event.target as HTMLImageElement;
        if (!img.classList.contains("app-icon")) return;
        const pkg = img.closest<HTMLElement>(".app-card")?.dataset.package;
        const item = pkg
            ? state.apps.find((a) => a.packageName === pkg)
            : undefined;
        if (!item) return;
        const fallback = document.createElement("div");
        fallback.className = "app-icon-fallback";
        fallback.style.background = iconSeed(item.packageName);
        fallback.textContent = initials(item.label);
        img.parentElement?.replaceWith(fallback);
    });
}

async function doWirelessConnect(): Promise<void> {
    const hostPort = state.wirelessHostPort.trim();
    if (!hostPort) return;
    const parts = hostPort.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        state.error = "Invalid format. Use host:port (e.g., 192.168.1.100:5555)";
        state.wirelessConnecting = false;
        updateWirelessForm();
        updateErrorBanner();
        return;
    }
    const [host, port] = parts;
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        state.error = "Port must be a number between 1 and 65535";
        state.wirelessConnecting = false;
        updateWirelessForm();
        updateErrorBanner();
        return;
    }
    state.wirelessConnecting = true;
    state.error = "";
    updateWirelessForm();
    updateErrorBanner();
    try {
        const result = await invoke<string>("adb_connect", { hostPort });
        console.log("adb_connect:", result);
        if (
            result.includes("already connected") ||
            result.includes("connected to")
        ) {
            await invoke("save_wireless_device", { hostPort });
            state.wirelessConnectOpen = false;
            state.wirelessHostPort = "";
            state.wirelessConnecting = false;
            await refreshAll();
            await loadWirelessDevices();
        } else {
            state.error = result;
            state.wirelessConnecting = false;
            updateWirelessForm();
            updateErrorBanner();
        }
    } catch (e: any) {
        state.error = String(e);
        state.wirelessConnecting = false;
        updateWirelessForm();
        updateErrorBanner();
    }
}

async function doWirelessDisconnect(hostPort: string): Promise<void> {
    state.error = "";
    updateTopBar();
    updateErrorBanner();
    try {
        await invoke("adb_disconnect", { hostPort });
        await invoke("remove_wireless_device", { hostPort });
        state.wirelessDevices = state.wirelessDevices.filter((d) => d !== hostPort);
        updateTopBar();
        updateSettings();
        updateErrorBanner();
    } catch (e: any) {
        state.error = String(e);
        updateErrorBanner();
    }
}

async function doWirelessReconnect(hostPort: string): Promise<void> {
    state.error = "";
    state.wirelessConnecting = true;
    updateWirelessForm();
    updateErrorBanner();
    try {
        const result = await invoke<string>("adb_connect", { hostPort });
        if (
            result.includes("already connected") ||
            result.includes("connected to")
        ) {
            state.wirelessConnecting = false;
            await refreshAll();
        } else {
            state.error = result;
            state.wirelessConnecting = false;
            updateWirelessForm();
            updateErrorBanner();
        }
    } catch (e: any) {
        state.error = String(e);
        state.wirelessConnecting = false;
        updateWirelessForm();
        updateErrorBanner();
    }
}

async function loadWirelessDevices(): Promise<void> {
    try {
        state.wirelessDevices = await invoke<string[]>("get_wireless_devices");
        updateSettings();
    } catch {
        state.wirelessDevices = [];
        updateSettings();
    }
}

async function closeSettings(): Promise<void> {
    state.settingsOpen = false;
    updateSettings();
}

async function refreshAll(): Promise<void> {
    state.error = "";
    state.loadingDevices = true;
    state.loadingApps = true;
    updateTopBar();
    updateErrorBanner();
    invoke("trigger_refresh");
    if (state.selectedSerial) beginLoadApps(state.selectedSerial);
    loadWirelessDevices();
}

async function loadSettings(): Promise<void> {
    state.settings = await invoke<SettingsState>("get_settings");
}

async function saveSettings(): Promise<void> {
    const current = state.settings;
    if (!current) return;
    const deviceDisplayBounds: Record<string, string> = {};
    document
        .querySelectorAll<HTMLInputElement>(".device-bounds-input")
        .forEach((input) => {
            const serial = input.dataset.serial;
            if (serial) {
                const val = input.value.trim();
                if (val) deviceDisplayBounds[serial] = val;
            }
        });
    const next: SettingsState = {
        ...current,
        adbPath:
            document
                .querySelector<HTMLInputElement>("#adbPath")
                ?.value.trim() || "adb",
        scrcpyPath:
            document
                .querySelector<HTMLInputElement>("#scrcpyPath")
                ?.value.trim() || "scrcpy",
        includeSystemApps: Boolean(
            document.querySelector<HTMLInputElement>("#includeSystemApps")
                ?.checked,
        ),
        iconSource:
            (document.querySelector<HTMLSelectElement>("#iconSource")?.value as
                | "web"
                | "none") || "none",
        flexDisplay: Boolean(
            document.querySelector<HTMLInputElement>("#flexDisplay")?.checked,
        ),
        killOnClose: Boolean(
            document.querySelector<HTMLInputElement>("#killOnClose")?.checked,
        ),
        displayBounds:
            document
                .querySelector<HTMLInputElement>("#displayBounds")
                ?.value.trim() || "",
        deviceDisplayBounds,
    };
    state.settings = await invoke<SettingsState>("save_settings", {
        settings: next,
    });
    state.settingsOpen = false;
    updateSettings();
    updateTopBar();
    invoke("trigger_refresh");
}

function readyDeviceKey(devices: Device[]): string {
    return devices
        .filter((device) => device.state === "device")
        .map(
            (device) =>
                `${device.serial}:${device.model || ""}:${device.androidVersion || ""}`,
        )
        .sort()
        .join("|");
}

function beginLoadApps(serial: string): void {
    state.loadingApps = true;
    state.error = "";
    updateAppGrid();
    invoke("trigger_load_apps", { serial });
}

async function loadCachedMetaAndResolve(): Promise<void> {
    // Layer 1: fill from disk cache immediately
    const cache = await invoke<Record<string, CachedAppMeta>>(
        "get_cached_app_meta",
    );
    state.cacheMeta = new Map(Object.entries(cache));
    let filled = 0;
    for (const app of state.apps) {
        const meta = state.cacheMeta.get(app.packageName);
        if (meta) {
            app.label = meta.label;
            app.iconUrl = meta.iconDataUrl ?? undefined;
            filled++;
        }
    }
    console.log(`[meta] cache filled ${filled}/${state.apps.length} apps`);
    updateAppGrid();

    // Layer 2: resolve uncached apps via web + ADB fallback
    const uncached = state.apps
        .filter((a) => !state.cacheMeta!.has(a.packageName))
        .map((a) => a.packageName);
    if (uncached.length === 0) {
        console.log("[meta] all apps cached");
        return;
    }
    state.resolveQueue = new Set(uncached);
    updateControlRow();
    console.log(`[meta] resolving ${uncached.length} uncached apps`);
    invoke("resolve_app_batch", {
        serial: state.selectedSerial,
        pkgs: uncached,
    }).catch((error) => {
        console.warn("[meta] resolve batch error:", error);
    });
}

async function launchMirror(serial: string): Promise<void> {
    try {
        await invoke("launch_mirror", { serial });
    } catch (error) {
        state.error = String(error);
        updateErrorBanner();
    }
}

async function launch(item: AndroidApp): Promise<void> {
    state.launchingPackage = item.packageName;
    state.error = "";
    state.launchMessages.delete(item.packageName);
    updateAppGrid();
    state.openApps.add(item.packageName);
    updateOpenStatus();
    try {
        const result = await invoke<LaunchResult>("launch_app", {
            serial: state.selectedSerial,
            packageName: item.packageName,
            label: item.label,
        });
        if (result.message) {
            state.launchMessages.set(item.packageName, {
                kind: "info",
                text: result.message,
            });
        }
    } catch (error) {
        state.launchMessages.set(item.packageName, {
            kind: "error",
            text: String(error),
        });
        state.openApps.delete(item.packageName);
        updateOpenStatus();
    } finally {
        state.launchingPackage = "";
        updateAppGrid();
    }
}

async function init(): Promise<void> {
    try {
        setupEventDelegation();
        initShell();
        await loadSettings();
        updateSettings();

        const openApps = await invoke<string[]>("get_open_apps");
        state.openApps = new Set(openApps);
        updateAppGrid();

        window.addEventListener("scroll", updateStickyState, { passive: true });

        // Background worker events — no sync ADB calls on main thread ever
        await listen<ToolStatus>("tool-status-updated", (event) => {
            state.tools = event.payload;
            updateTopBar();
        });

        await listen<string[]>("open-apps-updated", (event) => {
            state.openApps = new Set(event.payload);
            updateOpenStatus();
        });

        await listen<Device[]>("devices-updated", (event) => {
            const devices = event.payload;
            const previousSerial = state.selectedSerial;
            const previousKey = state.lastReadyDeviceKey;
            const nextKey = readyDeviceKey(devices);
            state.devices = devices;
            state.lastReadyDeviceKey = nextKey;
            state.loadingDevices = false;

            const ready = devices.filter((d) => d.state === "device");
            if (ready.length === 1) {
                state.selectedSerial = ready[0].serial;
            } else if (!ready.some((d) => d.serial === state.selectedSerial)) {
                state.selectedSerial = ready[0]?.serial || "";
            }

            updateTopBar();
            updateShellDeviceSerial();

            const selectedChanged = previousSerial !== state.selectedSerial;
            const devicesChanged = previousKey !== nextKey;
            if (state.selectedSerial && (selectedChanged || devicesChanged)) {
                beginLoadApps(state.selectedSerial);
            }
        });

        await listen<AppsLoadedEvent>("apps-loaded", (event) => {
            const { serial, apps } = event.payload;
            if (serial !== state.selectedSerial) return; // stale response
            state.apps = apps;
            state.loadingApps = false;
            updateAppGrid();
            loadCachedMetaAndResolve();
        });

        // Per-app metadata resolution events
        await listen<AppMetaResolvedEvent>("app-meta-resolved", (event) => {
            const { packageName, label, iconUrl } = event.payload;
            const app = state.apps.find((a) => a.packageName === packageName);
            if (app) {
                app.label = label;
                app.iconUrl = iconUrl ?? undefined;
                state.resolveQueue.delete(packageName);
                const card = document.querySelector<HTMLElement>(
                    `[data-package="${packageName}"]`,
                );
                if (card) updateCardElement(card, app);
                updateControlRow();
            }
        });

        // Batch complete — prune stale cache entries
        await listen("app-meta-batch-complete", () => {
            state.resolveQueue.clear();
            updateControlRow();
            const installedPkgs = state.apps.map((a) => a.packageName);
            invoke("prune_cache", { pkgs: installedPkgs }).catch(() => {});
            console.log("[meta] batch complete, cache pruned");
        });

        // Kick off the background worker
        invoke("trigger_refresh");
    } catch (error) {
        state.error = String(error);
        updateErrorBanner();
    }
}

void init();
