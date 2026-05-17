import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createIcons, Battery, BatteryFull, BatteryLow, BatteryMedium, Cable, MonitorSmartphone, Play, RefreshCw, Search, Settings, Smartphone, X } from "lucide";
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
  launchingPackage: "",
  launchMessages: new Map<string, { kind: "info" | "error"; text: string }>(),
};

const app = document.querySelector<HTMLDivElement>("#app")!;

window.addEventListener("error", (event) => {
  state.error = event.message || "A frontend error occurred.";
  render();
});

window.addEventListener("unhandledrejection", (event) => {
  state.error = String(event.reason || "An async frontend error occurred.");
  render();
});

function iconSeed(packageName: string): string {
  let hash = 0;
  for (const char of packageName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 70% 38%))`;
}

function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function prettyLabel(packageName: string): string {
  const tail = packageName.split(".").pop() || packageName;
  return tail.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function selectedDevice(): Device | undefined {
  return state.devices.find((device) => device.serial === state.selectedSerial);
}

function filteredApps(): AndroidApp[] {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.apps;
  return state.apps.filter((item) => {
    return item.label.toLowerCase().includes(query) || item.packageName.toLowerCase().includes(query);
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
  const tooltip = version
    ? `${label} ${version}`
    : binary.help;
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
    const tooltip = device.androidVersion
      ? `${device.model || device.serial} · Android ${device.androidVersion} · ${device.serial}`
      : device.serial;
    return `<div class="device-chip" title="${shellEscapeText(tooltip)}"><i data-lucide="smartphone"></i><span>${shellEscapeText(name)} ${batteryIcon(device.batteryLevel)}${device.batteryLevel !== undefined ? ` ${device.batteryLevel}%` : ""}</span></div>`;
  }

  return `
    <label class="device-select">
      <i data-lucide="smartphone"></i>
      <select id="deviceSelect" aria-label="Select Android device">
        ${state.devices
          .map((device) => {
            const name = `${device.model || device.serial}${device.androidVersion ? ` · Android ${device.androidVersion}` : ""}${device.batteryLevel !== undefined ? ` [${device.batteryLevel}%]` : ""}`;
            return `<option value="${shellEscapeText(device.serial)}" ${device.serial === state.selectedSerial ? "selected" : ""}>${shellEscapeText(name)}</option>`;
          })
          .join("")}
      </select>
    </label>
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
    try { createIcons({ icons: { MonitorSmartphone } }); } catch {}
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
    try { createIcons({ icons: { RefreshCw } }); } catch {}
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
    try { createIcons({ icons: { Search } }); } catch {}
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
  const el = document.querySelector(".count");
  if (el) {
    el.innerHTML = `${state.apps.length} apps${state.resolveQueue.size ? ` <span class="icon-loading">resolving ${state.resolveQueue.size}…</span>` : ""}`;
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

        ${state.devices.filter(d => d.state === "device").length > 0 ? `
          <details class="per-device-bounds">
            <summary>Per-device overrides</summary>
            ${state.devices.filter(d => d.state === "device").map(device => {
              const name = device.model || device.serial;
              const val = state.settings!.deviceDisplayBounds[device.serial] || "";
              return `
                <label class="field device-bounds-row">
                  <span>${shellEscapeText(name)}</span>
                  <input class="device-bounds-input" data-serial="${shellEscapeText(device.serial)}" value="${shellEscapeText(val)}" placeholder="Inherit global" />
                </label>
              `;
            }).join("")}
          </details>
        ` : ""}

        <label class="field">
          <span>Icon source</span>
          <select id="iconSource">
            <option value="none" ${state.settings.iconSource === "none" ? "selected" : ""}>Generated placeholders</option>
            <option value="web" ${state.settings.iconSource === "web" ? "selected" : ""}>Google Play metadata</option>
          </select>
        </label>

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

function render(): void {
  const device = selectedDevice();
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"><i data-lucide="monitor-smartphone"></i></div>
          <div>
            <h1>scrcpy Launcher</h1>
            <p>${device ? shellEscapeText(device.serial) : "Android apps as desktop windows"}</p>
          </div>
        </div>
        <div class="top-actions">
          ${state.tools ? renderStatusPill(state.tools.adb, "ADB") + renderStatusPill(state.tools.scrcpy, "scrcpy") : ""}
          ${renderDeviceSelect()}
          <button class="icon-button" id="reload" title="Rescan apps and devices"><i data-lucide="refresh-cw"></i></button>
          <button class="icon-button" id="settings" title="Settings"><i data-lucide="settings"></i></button>
        </div>
      </header>

      <section class="control-row">
        <label class="search-box">
          <i data-lucide="search"></i>
          <input id="search" value="${shellEscapeText(state.query)}" placeholder="Search apps or packages" autocomplete="off" />
        </label>
        <div class="count">${state.apps.length} apps${state.resolveQueue.size ? `<span class="icon-loading"> resolving ${state.resolveQueue.size}…</span>` : ""}</div>
      </section>

      ${state.error ? `<div class="error-banner">${shellEscapeText(state.error)}</div>` : ""}
      <section id="appGrid" class="app-grid"></section>
      ${renderSettings()}
    </main>
  `;
  try {
    createIcons({ icons: { Battery, BatteryFull, BatteryLow, BatteryMedium, Cable, MonitorSmartphone, Play, RefreshCw, Search, Settings, Smartphone, X } });
  } catch (error) {
    console.warn("Unable to render lucide icons", error);
  }
  updateAppGrid();
}

function setupEventDelegation(): void {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    if (target.closest("#settings")) {
      state.settingsOpen = true;
      render();
      return;
    }

    if (target.closest("#settingsX") || target.closest("#closeSettings")) {
      closeSettings();
      return;
    }

    if (target.closest("#reload")) {
      void refreshAll();
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
  });

  app.addEventListener("error", (event) => {
    const img = event.target as HTMLImageElement;
    if (!img.classList.contains("app-icon")) return;
    const pkg = img.closest<HTMLElement>(".app-card")?.dataset.package;
    const item = pkg ? state.apps.find((a) => a.packageName === pkg) : undefined;
    if (!item) return;
    const fallback = document.createElement("div");
    fallback.className = "app-icon-fallback";
    fallback.style.background = iconSeed(item.packageName);
    fallback.textContent = initials(item.label);
    img.parentElement?.replaceWith(fallback);
  });
}

function closeSettings(): void {
  state.settingsOpen = false;
  render();
}

async function refreshAll(): Promise<void> {
  state.error = "";
  state.loadingDevices = true;
  state.loadingApps = true;
  render();
  invoke("trigger_refresh");
  // Events arrive from background worker:
  //   tool-status-updated → update pills
  //   devices-updated     → auto-select, beginLoadApps
  //   apps-loaded         → render grid, loadCachedMetaAndResolve
}

async function loadSettings(): Promise<void> {
  state.settings = await invoke<SettingsState>("get_settings");
}

async function saveSettings(): Promise<void> {
  const current = state.settings;
  if (!current) return;
  const deviceDisplayBounds: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>(".device-bounds-input").forEach((input) => {
    const serial = input.dataset.serial;
    if (serial) {
      const val = input.value.trim();
      if (val) deviceDisplayBounds[serial] = val;
    }
  });
  const next: SettingsState = {
    ...current,
    adbPath: document.querySelector<HTMLInputElement>("#adbPath")?.value.trim() || "adb",
    scrcpyPath: document.querySelector<HTMLInputElement>("#scrcpyPath")?.value.trim() || "scrcpy",
    includeSystemApps: Boolean(document.querySelector<HTMLInputElement>("#includeSystemApps")?.checked),
    iconSource: (document.querySelector<HTMLSelectElement>("#iconSource")?.value as "web" | "none") || "none",
    flexDisplay: Boolean(document.querySelector<HTMLInputElement>("#flexDisplay")?.checked),
    killOnClose: Boolean(document.querySelector<HTMLInputElement>("#killOnClose")?.checked),
    displayBounds: document.querySelector<HTMLInputElement>("#displayBounds")?.value.trim() || "",
    deviceDisplayBounds,
  };
  state.settings = await invoke<SettingsState>("save_settings", { settings: next });
  state.settingsOpen = false;
  render();
  invoke("trigger_refresh");
}

function readyDeviceKey(devices: Device[]): string {
  return devices
    .filter((device) => device.state === "device")
    .map((device) => `${device.serial}:${device.model || ""}:${device.androidVersion || ""}`)
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
  const cache = await invoke<Record<string, CachedAppMeta>>("get_cached_app_meta");
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
  const uncached = state.apps.filter((a) => !state.cacheMeta!.has(a.packageName)).map((a) => a.packageName);
  if (uncached.length === 0) {
    console.log("[meta] all apps cached");
    return;
  }
  state.resolveQueue = new Set(uncached);
  updateControlRow();
  console.log(`[meta] resolving ${uncached.length} uncached apps`);
  invoke("resolve_app_batch", { serial: state.selectedSerial, pkgs: uncached }).catch((error) => {
    console.warn("[meta] resolve batch error:", error);
  });
}

async function launch(item: AndroidApp): Promise<void> {
  state.launchingPackage = item.packageName;
  state.error = "";
  state.launchMessages.delete(item.packageName);
  updateAppGrid();
  try {
    const result = await invoke<LaunchResult>("launch_app", {
      serial: state.selectedSerial,
      packageName: item.packageName,
      label: item.label,
    });
    if (result.message) {
      state.launchMessages.set(item.packageName, { kind: "info", text: result.message });
    }
  } catch (error) {
    state.launchMessages.set(item.packageName, { kind: "error", text: String(error) });
  } finally {
    state.launchingPackage = "";
    updateAppGrid();
  }
}

async function init(): Promise<void> {
  try {
    setupEventDelegation();
    render();
    await loadSettings();
    render();

    // Background worker events — no sync ADB calls on main thread ever
    await listen<ToolStatus>("tool-status-updated", (event) => {
      state.tools = event.payload;
      render();
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

      render();

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
        const card = document.querySelector<HTMLElement>(`[data-package="${packageName}"]`);
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
    render();
  }
}

void init();
