import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetState, state } from "./state";
import type { BinaryStatus, AndroidApp, Folder, Device } from "./types";

vi.mock("lucide", () => ({
    createIcons: vi.fn(),
    Battery: "i",
    BatteryCharging: "i",
    BatteryFull: "i",
    BatteryLow: "i",
    BatteryMedium: "i",
    MonitorSmartphone: "i",
    Play: "i",
    RefreshCw: "i",
    Search: "i",
    Server: "i",
    Settings: "i",
    Smartphone: "i",
    Trash2: "i",
    Wifi: "i",
    X: "i",
}));

beforeEach(() => {
    resetState();
    document.body.innerHTML = '<div id="app"></div>';
});

import {
    renderStatusPill,
    highlightText,
    renderAppIcon,
    initShell,
    updateAppGrid,
    updateErrorBanner,
    updateTopBar,
    createAppCardElement,
    createFolderElement,
    renderContextMenu,
    updateNotificationBadges,
    updateCardElement,
    openFolder,
    renderDeviceSelect,
    renderBatteryPill,
    renderTempPill,
    renderWirelessForm,
    renderSettings,
    showConnectionGuide,
    closeCreateFolderModal,
    openCreateFolderModal,
} from "./render";

function initDOM(): void {
    initShell();
    // state is fresh from resetState, re-init queries
    const search = document.getElementById("search") as HTMLInputElement | null;
    if (search) search.value = "";
}

describe("renderStatusPill", () => {
    it("renders ok pill when binary found", () => {
        const binary: BinaryStatus = { path: "/usr/bin/adb", found: true, version: "1.0.0", help: "" };
        const html = renderStatusPill(binary, "ADB");
        expect(html).toContain('class="pill ok"');
        expect(html).toContain("ADB");
        expect(html).toContain("1.0.0");
    });

    it("renders bad pill when binary not found", () => {
        const binary: BinaryStatus = { path: "adb", found: false, help: "not found" };
        const html = renderStatusPill(binary, "ADB");
        expect(html).toContain('class="pill bad"');
        expect(html).toContain("not found");
    });
});

describe("highlightText", () => {
    it("wraps matching text in highlight span", () => {
        const result = highlightText("Hello World", "World");
        expect(result).toContain('<span class="highlight">World</span>');
    });

    it("is case-insensitive", () => {
        const result = highlightText("Hello World", "world");
        expect(result).toContain('<span class="highlight">World</span>');
    });

    it("returns escaped text when no match", () => {
        const result = highlightText("Hello World", "xyz");
        expect(result).toBe("Hello World");
        expect(result).not.toContain("highlight");
    });

    it("handles empty query", () => {
        const result = highlightText("Hello", "");
        expect(result).toBe("Hello");
    });

    it("escapes HTML in the output", () => {
        const result = highlightText("<test>", "test");
        expect(result).toContain("&lt;");
    });
});

describe("renderAppIcon", () => {
    it("renders img when iconUrl present", () => {
        const app: AndroidApp = { packageName: "com.test", label: "Test", iconUrl: "data:image/png,abc" };
        const html = renderAppIcon(app);
        expect(html).toContain('<img class="app-icon"');
        expect(html).toContain("data:image/png,abc");
    });

    it("renders fallback div when no iconUrl", () => {
        const app: AndroidApp = { packageName: "com.test", label: "Test" };
        const html = renderAppIcon(app);
        expect(html).toContain('class="app-icon-fallback"');
        expect(html).toContain("T");
    });
});

describe("renderDeviceSelect", () => {
    it("shows muted chip when loading devices", () => {
        state.loadingDevices = true;
        state.devices = [];
        const html = renderDeviceSelect();
        expect(html).toContain("muted");
        expect(html).toContain("Finding devices");
    });

    it("shows warning chip when no devices", () => {
        state.loadingDevices = false;
        state.devices = [];
        const html = renderDeviceSelect();
        expect(html).toContain("warning");
        expect(html).toContain("No devices");
    });

    it("shows device pill for single device with mirror button", () => {
        state.loadingDevices = false;
        state.devices = [{ serial: "abc", state: "device", model: "Pixel", wireless: false, stableId: "abc" }];
        const html = renderDeviceSelect();
        expect(html).toContain("device-pill");
        expect(html).toContain("Pixel");
        expect(html).toContain('data-mirror="abc"');
        expect(html).toContain('data-lucide="usb"');
    });

    it("shows device pill with dropdown for multiple devices", () => {
        state.loadingDevices = false;
        state.devices = [
            { serial: "abc", state: "device", model: "Pixel", wireless: false, stableId: "abc" },
            { serial: "def", state: "device", model: "Nexus", wireless: true, stableId: "def" },
        ];
        const html = renderDeviceSelect();
        expect(html).toContain("device-pill");
        expect(html).toContain("device-pill-dropdown");
        expect(html).toContain("Pixel");
        expect(html).toContain("Nexus");
        expect(html).toContain("chevron-down");
        expect(html).toContain('data-mirror="abc"');
    });
});

describe("renderBatteryPill", () => {
    it("renders when device has battery level", () => {
        state.devices = [{ serial: "abc", state: "device", batteryLevel: 80, batteryCharging: false, wireless: false, stableId: "abc" }];
        state.selectedSerial = "abc";
        const html = renderBatteryPill();
        expect(html).toContain("80%");
    });

    it("includes charging icon when charging", () => {
        state.devices = [{ serial: "abc", state: "device", batteryLevel: 50, batteryCharging: true, wireless: false, stableId: "abc" }];
        state.selectedSerial = "abc";
        const html = renderBatteryPill();
        expect(html).toContain("battery-charging");
    });

    it("returns empty string when no device", () => {
        expect(renderBatteryPill()).toBe("");
    });
});

describe("renderTempPill", () => {
    it("renders temperature when available", () => {
        state.devices = [{ serial: "abc", state: "device", batteryTemperature: 36.5, wireless: false, stableId: "abc" }];
        state.selectedSerial = "abc";
        const html = renderTempPill();
        expect(html).toContain("36.5");
    });

    it("returns empty string when no device", () => {
        expect(renderTempPill()).toBe("");
    });
});

describe("renderWirelessForm", () => {
    it("shows Connect button by default", () => {
        const html = renderWirelessForm();
        expect(html).toContain("Connect");
        expect(html).not.toContain("Connecting");
    });

    it("shows Connecting… when connecting", () => {
        state.wirelessConnecting = true;
        const html = renderWirelessForm();
        expect(html).toContain("Connecting");
    });

    it("shows Connected when connected", () => {
        state.wirelessConnectResult = "ok";
        const html = renderWirelessForm();
        expect(html).toContain("Connected");
        expect(html).toContain("connected");
    });

    it("shows inline error message", () => {
        state.wirelessConnectResult = "error";
        state.wirelessConnectMsg = "Connection refused";
        const html = renderWirelessForm();
        expect(html).toContain("wireless-error");
        expect(html).toContain("Connection refused");
    });
});

describe("renderSettings", () => {
    it("returns empty string when settings is null", () => {
        state.settings = null;
        expect(renderSettings()).toBe("");
    });

    it("renders settings form when settings exist", () => {
        state.settings = {
            adbPath: "/usr/bin/adb",
            scrcpyPath: "/usr/bin/scrcpy",
            includeSystemApps: true,
            iconSource: "none",
            flexDisplay: false,
            webEnabled: false,
            adbFallback: false,
            killOnClose: true,
            displayBounds: "",
            deviceDisplayBounds: {},
            wirelessDevices: [],
            lastWirelessHost: "",
            lastWirelessPort: "5555",
            folders: {},
            deviceNicknames: {},
            ignoredUpdateVersion: "",
            globalScrcpyArgs: "",
            deviceScrcpyArgs: {},
            appScrcpyArgs: {},
        };
        state.devices = [{ serial: "abc", state: "device", wireless: false, stableId: "abc" }];
        const html = renderSettings();
        expect(html).toContain('id="adbPath"');
        expect(html).toContain('/usr/bin/adb');
        expect(html).toContain('id="scrcpyPath"');
        expect(html).toContain('id="includeSystemApps"');
        expect(html).toContain('id="killOnClose"');
    });
});

describe("initShell / DOM setup", () => {
    it("creates all required DOM elements", () => {
        initDOM();
        expect(document.getElementById("app-shell")).toBeTruthy();
        expect(document.getElementById("top-actions")).toBeTruthy();
        expect(document.getElementById("search")).toBeTruthy();
        expect(document.getElementById("wireless-container")).toBeTruthy();
        expect(document.getElementById("error-container")).toBeTruthy();
        expect(document.getElementById("context-menu")).toBeTruthy();
        expect(document.getElementById("appGrid")).toBeTruthy();
        expect(document.getElementById("closeSettings")).toBeTruthy();
        expect(document.getElementById("settings-panel")).toBeTruthy();
        expect(document.getElementById("folder-modal")).toBeTruthy();
        expect(document.getElementById("create-folder-modal")).toBeTruthy();
        expect(document.getElementById("guide-modal")).toBeTruthy();
    });
});

describe("updateErrorBanner", () => {
    it("shows error banner when state.error is set", () => {
        initDOM();
        state.error = "Something went wrong";
        updateErrorBanner();
        const banner = document.querySelector(".error-banner");
        expect(banner).toBeTruthy();
        expect(banner?.textContent).toBe("Something went wrong");
    });

    it("clears error banner when state.error is empty", () => {
        initDOM();
        state.error = "previous error";
        updateErrorBanner();
        expect(document.querySelector(".error-banner")).toBeTruthy();
        state.error = "";
        updateErrorBanner();
        expect(document.querySelector(".error-banner")).toBeFalsy();
    });
});

describe("updateTopBar", () => {
    it("renders status pills when tools present", () => {
        initDOM();
        state.tools = {
            adb: { path: "adb", found: true, version: "1.0", help: "" },
            scrcpy: { path: "scrcpy", found: false, help: "not found" },
        };
        updateTopBar();
        const container = document.getElementById("top-actions");
        expect(container?.innerHTML).toContain("ADB");
        expect(container?.innerHTML).toContain("scrcpy");
        expect(container?.innerHTML).toContain('id="adbRestart"');
        expect(container?.innerHTML).toContain('id="wirelessConnect"');
        expect(container?.innerHTML).toContain('id="reload"');
        expect(container?.innerHTML).toContain('id="settings"');
    });
});

describe("createAppCardElement", () => {
    it("creates a button with data attributes", () => {
        const app: AndroidApp = { packageName: "com.test", label: "Test App" };
        const el = createAppCardElement(app);
        expect(el.tagName).toBe("BUTTON");
        expect(el.dataset.package).toBe("com.test");
        expect(el.dataset.launch).toBe("com.test");
    });

    it("adds open class when app is open", () => {
        state.openApps.add("com.test");
        const app: AndroidApp = { packageName: "com.test", label: "Test App" };
        const el = createAppCardElement(app);
        expect(el.classList.contains("open")).toBe(true);
    });

    it("adds favorite class when app is favorited", () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.test"] } };
        const app: AndroidApp = { packageName: "com.test", label: "Test App" };
        const el = createAppCardElement(app);
        expect(el.classList.contains("favorite")).toBe(true);
    });
});

describe("createFolderElement", () => {
    it("renders folder card with preview icons", () => {
        state.apps = [
            { packageName: "com.a", label: "A", iconUrl: "data:png,a" },
            { packageName: "com.b", label: "B", iconUrl: "data:png,b" },
        ];
        const folder: Folder = { id: "games", name: "Games", apps: ["com.a", "com.b"] };
        const el = createFolderElement(folder);
        expect(el.classList.contains("folder-card")).toBe(true);
        expect(el.dataset.folderId).toBe("games");
        expect(el.querySelector(".folder-preview")).toBeTruthy();
        expect(el.querySelector(".folder-label")?.textContent).toBe("Games");
    });

    it("shows overflow count when more than 4 apps", () => {
        state.apps = Array.from({ length: 6 }, (_, i) => ({
            packageName: `com.a${i}`,
            label: `App ${i}`,
        }));
        const folder: Folder = { id: "test", name: "Test", apps: ["com.a0", "com.a1", "com.a2", "com.a3", "com.a4", "com.a5"] };
        const el = createFolderElement(folder);
        expect(el.querySelector(".folder-count")?.textContent).toBe("+2");
    });
});

describe("updateAppGrid", () => {
    it("shows empty state when no selected serial", () => {
        initDOM();
        state.selectedSerial = "";
        updateAppGrid();
        const empty = document.querySelector(".empty");
        expect(empty).toBeTruthy();
        expect(empty?.textContent).toContain("Connect an Android device");
    });

    it("shows loading state", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = true;
        updateAppGrid();
        const empty = document.querySelector(".empty");
        expect(empty).toBeTruthy();
        expect(empty?.textContent).toContain("Loading apps");
    });

    it("shows no apps found when filtered list is empty", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = false;
        state.apps = [];
        updateAppGrid();
        const empty = document.querySelector(".empty");
        expect(empty).toBeTruthy();
        expect(empty?.textContent).toContain("No apps found");
    });

    it("renders folder cards and app cards", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = false;
        state.apps = [
            { packageName: "com.a", label: "Alpha" },
            { packageName: "com.b", label: "Beta" },
        ];
        state.folders["abc"] = { games: { id: "games", name: "Games", apps: ["com.a"] } };
        updateAppGrid();
        expect(document.querySelector(".folder-card")).toBeTruthy();
        expect(document.querySelector(".app-card")).toBeTruthy();
    });
});

describe("updateNotificationBadges", () => {
    it("adds badge for app with notification count", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = false;
        state.apps = [{ packageName: "com.test", label: "Test" }];
        state.notificationCounts = { "com.test": 5 };
        updateAppGrid();
        updateNotificationBadges();
        const badge = document.querySelector(".notification-badge");
        expect(badge).toBeTruthy();
        expect(badge?.textContent).toBe("5");
    });

    it("shows 99+ for counts over 99", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = false;
        state.apps = [{ packageName: "com.test", label: "Test" }];
        state.notificationCounts = { "com.test": 100 };
        updateAppGrid();
        updateNotificationBadges();
        expect(document.querySelector(".notification-badge")?.textContent).toBe("99+");
    });

    it("removes badge when count drops to zero", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.loadingApps = false;
        state.apps = [{ packageName: "com.test", label: "Test" }];
        state.notificationCounts = { "com.test": 3 };
        updateAppGrid();
        updateNotificationBadges();
        expect(document.querySelector(".notification-badge")).toBeTruthy();
        state.notificationCounts = {};
        updateNotificationBadges();
        expect(document.querySelector(".notification-badge")).toBeFalsy();
    });
});

describe("renderContextMenu", () => {
    it("hides menu when contextMenu is null", () => {
        initDOM();
        state.contextMenu = null;
        renderContextMenu();
        const menu = document.getElementById("context-menu");
        expect(menu?.style.display).toBe("none");
    });

    it("shows menu with favorite toggle and folder options", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.folders["abc"] = { games: { id: "games", name: "Games", apps: [] } };
        state.contextMenu = { x: 100, y: 100, pkg: "com.test" };
        renderContextMenu();
        const menu = document.getElementById("context-menu");
        expect(menu?.style.display).toBe("block");
        expect(menu?.innerHTML).toContain("Add to Favorites");
        expect(menu?.innerHTML).toContain("Create New Folder");
        expect(menu?.innerHTML).toContain("Add to Games");
    });

    it("shows Remove from Favorites when already favorited", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.test"] } };
        state.contextMenu = { x: 100, y: 100, pkg: "com.test" };
        renderContextMenu();
        expect(document.getElementById("context-menu")?.innerHTML).toContain("Remove from Favorites");
    });

    it("flips position when near right edge", () => {
        initDOM();
        const menu = document.getElementById("context-menu")!;
        Object.defineProperty(menu, "offsetWidth", { value: 100, configurable: true });
        Object.defineProperty(window, "innerWidth", { value: 200, configurable: true });
        state.contextMenu = { x: 180, y: 100, pkg: "com.test" };
        renderContextMenu();
        const left = parseInt(menu.style.left || "0");
        expect(left).toBe(80);
        Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    });
});

describe("updateCardElement", () => {
    it("updates card classes and content", () => {
        initDOM();
        const app: AndroidApp = { packageName: "com.test", label: "Test" };
        const card = createAppCardElement(app);
        state.openApps.add("com.test");
        const updatedApp: AndroidApp = { packageName: "com.test", label: "Updated" };
        updateCardElement(card, updatedApp);
        expect(card.classList.contains("open")).toBe(true);
        expect(card.querySelector(".app-name")?.textContent).toBe("Updated");
    });
});

describe("openFolder / modals", () => {
    it("opens folder modal and shows apps", () => {
        initDOM();
        state.selectedSerial = "abc";
        state.apps = [{ packageName: "com.a", label: "Alpha" }];
        state.folders["abc"] = { test: { id: "test", name: "Test", apps: ["com.a"] } };
        openFolder("test");
        const modal = document.getElementById("folder-modal");
        expect(modal?.classList.contains("open")).toBe(true);
        expect(modal?.textContent).toContain("Test");
        expect(modal?.textContent).toContain("Alpha");
    });

    it("closes folder modal when id is null", () => {
        initDOM();
        openFolder("test");
        openFolder(null);
        const modal = document.getElementById("folder-modal");
        expect(modal?.classList.contains("open")).toBe(false);
    });
});

describe("createFolderModal", () => {
    it("opens and sets pkg", () => {
        initDOM();
        openCreateFolderModal("com.test");
        const modal = document.getElementById("create-folder-modal");
        expect(modal?.classList.contains("open")).toBe(true);
        expect(state.createFolderPkg).toBe("com.test");
    });

    it("closes and clears pkg", () => {
        initDOM();
        openCreateFolderModal("com.test");
        closeCreateFolderModal();
        const modal = document.getElementById("create-folder-modal");
        expect(modal?.classList.contains("open")).toBe(false);
        expect(state.createFolderPkg).toBe("");
    });
});

describe("showConnectionGuide", () => {
    it("opens guide modal", () => {
        initDOM();
        showConnectionGuide();
        const modal = document.getElementById("guide-modal");
        expect(modal?.classList.contains("open")).toBe(true);
    });
});
