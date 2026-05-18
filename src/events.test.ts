import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetState, state } from "./state";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(() => Promise.resolve(() => {})),
}));

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
    Wifi: "i",
    X: "i",
}));

import { initShell, updateWirelessForm, updateAppGrid } from "./render";
import { setupEventDelegation } from "./events";

function initDOM(): void {
    document.body.innerHTML = '<div id="app"></div>';
    initShell();
}

beforeEach(() => {
    resetState();
    initDOM();
    setupEventDelegation();
    vi.clearAllMocks();
});

function click(id: string): void {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found`);
    el.click();
}

function clickClosest(selector: string): void {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element ${selector} not found`);
    (el as HTMLElement).click();
}

describe("setupEventDelegation - topbar buttons", () => {
    it("opens settings on settings button click", () => {
        click("settings");
        expect(state.settingsOpen).toBe(true);
    });

    it("toggles wireless form on wireless button click", () => {
        click("wirelessConnect");
        expect(state.wirelessConnectOpen).toBe(true);
        click("wirelessConnect");
        expect(state.wirelessConnectOpen).toBe(false);
    });

    it("clears wireless host/port state when toggling form", () => {
        state.wirelessHost = "192.168.1.1";
        state.wirelessPort = "5555";
        state.wirelessConnectResult = "error";
        state.wirelessConnectMsg = "bad";
        click("wirelessConnect");
        expect(state.wirelessHost).toBe("");
        expect(state.wirelessPort).toBe("5555");
        expect(state.wirelessConnectResult).toBeNull();
        expect(state.wirelessConnectMsg).toBe("");
    });
});

describe("setupEventDelegation - modals", () => {
    it("closes guide modal via close button", () => {
        document.getElementById("guide-modal")?.classList.add("open");
        click("closeGuideModal");
        expect(document.getElementById("guide-modal")?.classList.contains("open")).toBe(false);
    });

    it("closes guide modal via overlay click", () => {
        document.getElementById("guide-modal")?.classList.add("open");
        const overlay = document.querySelector("#guide-modal .modal-overlay") as HTMLElement;
        overlay?.click();
        expect(document.getElementById("guide-modal")?.classList.contains("open")).toBe(false);
    });
});

describe("setupEventDelegation - settings", () => {
    it("closes settings via X button", () => {
        state.settingsOpen = true;
        click("settingsX");
        expect(state.settingsOpen).toBe(false);
    });

    it("closes settings via scrim", () => {
        state.settingsOpen = true;
        click("closeSettings");
        expect(state.settingsOpen).toBe(false);
    });
});

describe("setupEventDelegation - wireless form", () => {
    it("closes wireless form via close button", () => {
        state.wirelessConnectOpen = true;
        updateWirelessForm();
        click("closeWirelessForm");
        expect(state.wirelessConnectOpen).toBe(false);
    });
});

describe("setupEventDelegation - clear search", () => {
    it("clears search and updates grid", () => {
        state.selectedSerial = "abc";
        state.apps = [];
        state.loadingApps = false;
        state.query = "test";
        updateAppGrid();
        const searchInput = document.getElementById("search") as HTMLInputElement;
        searchInput.value = "test";
        click("clearSearch");
        expect(state.query).toBe("");
        expect(searchInput.value).toBe("");
    });
});

describe("setupEventDelegation - keyboard events", () => {
    it("closes folder modal with Escape when createFolderPkg is set", () => {
        state.createFolderPkg = "com.test";
        document.getElementById("create-folder-modal")?.classList.add("open");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(state.createFolderPkg).toBe("");
    });
});

describe("setupEventDelegation - search input", () => {
    it("updates query and debounces grid update", async () => {
        vi.useFakeTimers();
        const input = document.getElementById("search") as HTMLInputElement;
        input.value = "new query";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(state.query).toBe("new query");
        vi.advanceTimersByTime(200);
        vi.useRealTimers();
    });
});

describe("setupEventDelegation - folder card click", () => {
    it("opens folder when folder card is clicked", () => {
        const grid = document.getElementById("appGrid")!;
        const folderCard = document.createElement("div");
        folderCard.className = "folder-card";
        folderCard.dataset.folderId = "test-folder";
        grid.appendChild(folderCard);
        folderCard.click();
        expect(state.currentFolderId).toBe("test-folder");
    });
});

describe("setupEventDelegation - device select change", () => {
    it("triggers app loading on device select change", () => {
        const select = document.createElement("select");
        select.id = "deviceSelect";
        const option = document.createElement("option");
        option.value = "abc123";
        select.appendChild(option);
        select.value = "abc123";
        document.getElementById("app-shell")?.appendChild(select);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        expect(state.selectedSerial).toBe("abc123");
    });
});

describe("setupEventDelegation - app launch from card", () => {
    it("sets launchingPackage when app card clicked", () => {
        state.apps = [{ packageName: "com.test", label: "Test App" }];
        const grid = document.getElementById("appGrid")!;
        const card = document.createElement("button");
        card.className = "app-card";
        card.dataset.launch = "com.test";
        grid.appendChild(card);
        card.click();
        expect(state.launchingPackage).toBe("com.test");
    });
});
