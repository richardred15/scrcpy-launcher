import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetState, state } from "./state";
import type { AndroidApp, SettingsState } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

const mockRender = vi.hoisted(() => ({
    updateAppGrid: vi.fn(),
    updateErrorBanner: vi.fn(),
    updateTopBar: vi.fn(),
    updateWirelessForm: vi.fn(),
    updateSettings: vi.fn(),
    updateControlRow: vi.fn(),
    updateOpenStatus: vi.fn(),
    updateNotificationBadges: vi.fn(),
    renderContextMenu: vi.fn(),
    closeCreateFolderModal: vi.fn(),
    openCreateFolderModal: vi.fn(),
}));

vi.mock("./render", () => mockRender);

import { invoke } from "@tauri-apps/api/core";
import {
    addToFolder,
    confirmCreateFolder,
    createFolderPrompt,
    doWirelessConnect,
    doWirelessDisconnect,
    doWirelessReconnect,
    loadWirelessDevices,
    closeSettings,
    restartAdb,
    refreshAll,
    loadSettings,
    saveSettings,
    beginLoadApps,
    loadCachedMetaAndResolve,
    launchMirror,
    launch,
    fetchNotificationCounts,
} from "./actions";

beforeEach(() => {
    resetState();
    vi.clearAllMocks();
});

describe("fetchNotificationCounts", () => {
    it("calls invoke and updates state", async () => {
        vi.mocked(invoke).mockResolvedValue({ "com.test": 3 });
        state.selectedSerial = "abc";
        await fetchNotificationCounts();
        expect(invoke).toHaveBeenCalledWith("get_notification_counts", { serial: "abc" });
        expect(state.notificationCounts).toEqual({ "com.test": 3 });
        expect(mockRender.updateNotificationBadges).toHaveBeenCalled();
    });

    it("does nothing when no serial selected", async () => {
        state.selectedSerial = "";
        await fetchNotificationCounts();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("handles invoke error gracefully", async () => {
        vi.mocked(invoke).mockRejectedValue("error");
        state.selectedSerial = "abc";
        await fetchNotificationCounts();
        expect(state.notificationCounts).toEqual({});
    });
});

describe("addToFolder", () => {
    it("removes from favorites when already favorited", async () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.test"] } };
        vi.mocked(invoke).mockResolvedValue(undefined);
        await addToFolder("favorites", "com.test");
        expect(invoke).toHaveBeenCalledWith("remove_app_from_folder", { serial: "abc", folderId: "favorites", packageName: "com.test" });
        expect(state.folders["abc"]?.favorites?.apps).not.toContain("com.test");
        expect(mockRender.updateAppGrid).toHaveBeenCalled();
    });

    it("adds to favorites when not favorited", async () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: [] } };
        vi.mocked(invoke).mockResolvedValue(undefined);
        await addToFolder("favorites", "com.test");
        expect(invoke).toHaveBeenCalledWith("add_app_to_folder", { serial: "abc", folderId: "favorites", packageName: "com.test" });
        expect(state.folders["abc"]?.favorites?.apps).toContain("com.test");
    });

    it("auto-creates favorites folder on first add", async () => {
        state.selectedSerial = "abc";
        vi.mocked(invoke).mockResolvedValue(undefined);
        await addToFolder("favorites", "com.test");
        expect(state.folders["abc"]?.["favorites"]).toBeDefined();
        expect(state.folders["abc"]?.["favorites"]?.apps).toEqual(["com.test"]);
    });

    it("adds to regular folder", async () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { games: { id: "games", name: "Games", apps: [] } };
        vi.mocked(invoke).mockResolvedValue(undefined);
        await addToFolder("games", "com.game");
        expect(invoke).toHaveBeenCalledWith("add_app_to_folder", { serial: "abc", folderId: "games", packageName: "com.game" });
        expect(state.folders["abc"]?.games?.apps).toContain("com.game");
    });

    it("handles error", async () => {
        state.selectedSerial = "abc";
        vi.mocked(invoke).mockRejectedValue("Failed");
        await addToFolder("favorites", "com.test");
        expect(mockRender.updateErrorBanner).toHaveBeenCalled();
        expect(state.error).toBe("Failed");
    });
});

describe("confirmCreateFolder", () => {
    it("validates non-empty name", async () => {
        state.selectedSerial = "abc";
        document.body.innerHTML = `<input id="createFolderName" value="" />`;
        state.createFolderPkg = "com.test";
        await confirmCreateFolder();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("creates folder and adds app", async () => {
        state.selectedSerial = "abc";
        document.body.innerHTML = `<input id="createFolderName" value="My Games" />`;
        state.createFolderPkg = "com.test";
        vi.mocked(invoke).mockResolvedValueOnce("new-folder-id").mockResolvedValueOnce(undefined);
        await confirmCreateFolder();
        expect(invoke).toHaveBeenCalledWith("create_folder", { serial: "abc", name: "My Games" });
        expect(state.folders["abc"]?.["new-folder-id"]).toEqual({ id: "new-folder-id", name: "My Games", apps: ["com.test"] });
        expect(mockRender.closeCreateFolderModal).toHaveBeenCalled();
    });
});

describe("createFolderPrompt", () => {
    it("opens create folder modal", () => {
        createFolderPrompt("com.test");
        expect(mockRender.openCreateFolderModal).toHaveBeenCalledWith("com.test");
    });
});

describe("doWirelessConnect", () => {
    it("validates host is required", async () => {
        state.wirelessHost = "";
        await doWirelessConnect();
        expect(state.wirelessConnectResult).toBe("error");
        expect(state.wirelessConnectMsg).toBe("IP address is required");
        expect(mockRender.updateWirelessForm).toHaveBeenCalled();
    });

    it("validates port range", async () => {
        state.wirelessHost = "192.168.1.1";
        state.wirelessPort = "99999";
        await doWirelessConnect();
        expect(state.wirelessConnectResult).toBe("error");
        expect(state.wirelessConnectMsg).toContain("Port");
    });

    it("connects successfully", async () => {
        state.wirelessHost = "192.168.1.100";
        state.wirelessPort = "5555";
        state.settings = {
            adbPath: "adb",
            scrcpyPath: "scrcpy",
            includeSystemApps: false,
            iconSource: "none",
            flexDisplay: false,
            webEnabled: false,
            adbFallback: false,
            killOnClose: false,
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
        vi.mocked(invoke).mockResolvedValue("connected to 192.168.1.100:5555");
        await doWirelessConnect();
        expect(invoke).toHaveBeenCalledWith("adb_connect", { hostPort: "192.168.1.100:5555" });
        expect(invoke).toHaveBeenCalledWith("save_wireless_device", { hostPort: "192.168.1.100:5555" });
        expect(state.wirelessConnectOpen).toBe(false);
    });

    it("handles connection failure", async () => {
        state.wirelessHost = "192.168.1.100";
        vi.mocked(invoke).mockResolvedValue("failed: no route to host");
        await doWirelessConnect();
        expect(state.wirelessConnectResult).toBe("error");
        expect(state.wirelessConnectMsg).toContain("failed");
    });

    it("handles invoke exception", async () => {
        state.wirelessHost = "192.168.1.100";
        vi.mocked(invoke).mockRejectedValue("Network error");
        await doWirelessConnect();
        expect(state.wirelessConnectResult).toBe("error");
    });

    it("defaults port to 5555", async () => {
        state.wirelessHost = "192.168.1.100";
        state.wirelessPort = "";
        vi.mocked(invoke).mockResolvedValue("connected to 192.168.1.100:5555");
        await doWirelessConnect();
        expect(invoke).toHaveBeenCalledWith("adb_connect", { hostPort: "192.168.1.100:5555" });
    });
});

describe("doWirelessDisconnect", () => {
    it("disconnects and removes device", async () => {
        state.wirelessDevices = ["192.168.1.100:5555"];
        vi.mocked(invoke).mockResolvedValue(undefined);
        await doWirelessDisconnect("192.168.1.100:5555");
        expect(invoke).toHaveBeenCalledWith("adb_disconnect", { hostPort: "192.168.1.100:5555" });
        expect(invoke).toHaveBeenCalledWith("remove_wireless_device", { hostPort: "192.168.1.100:5555" });
        expect(state.wirelessDevices).not.toContain("192.168.1.100:5555");
    });

    it("handles error", async () => {
        vi.mocked(invoke).mockRejectedValue("Disconnect failed");
        await doWirelessDisconnect("addr");
        expect(state.error).toBe("Disconnect failed");
    });
});

describe("doWirelessReconnect", () => {
    it("reconnects and refreshes", async () => {
        state.selectedSerial = "abc";
        vi.mocked(invoke).mockResolvedValue("connected to 192.168.1.100:5555");
        await doWirelessReconnect("192.168.1.100:5555");
        expect(invoke).toHaveBeenCalledWith("adb_connect", { hostPort: "192.168.1.100:5555" });
    });

    it("shows error when reconnection fails", async () => {
        vi.mocked(invoke).mockResolvedValue("failed");
        await doWirelessReconnect("addr");
        expect(state.error).toBe("failed");
    });
});

describe("loadWirelessDevices", () => {
    it("loads devices and updates settings", async () => {
        vi.mocked(invoke).mockResolvedValue(["192.168.1.1:5555"]);
        await loadWirelessDevices();
        expect(state.wirelessDevices).toEqual(["192.168.1.1:5555"]);
        expect(mockRender.updateSettings).toHaveBeenCalled();
    });

    it("handles error", async () => {
        vi.mocked(invoke).mockRejectedValue("error");
        await loadWirelessDevices();
        expect(state.wirelessDevices).toEqual([]);
    });
});

describe("closeSettings", () => {
    it("closes settings panel", async () => {
        state.settingsOpen = true;
        await closeSettings();
        expect(state.settingsOpen).toBe(false);
        expect(mockRender.updateSettings).toHaveBeenCalled();
    });
});

describe("restartAdb", () => {
    it("restarts ADB and triggers refresh", async () => {
        state.selectedSerial = "abc";
        vi.mocked(invoke).mockResolvedValue(undefined);
        await restartAdb();
        expect(invoke).toHaveBeenCalledWith("adb_restart_server");
        expect(state.loadingDevices).toBe(true);
        expect(state.loadingApps).toBe(true);
        expect(mockRender.updateTopBar).toHaveBeenCalled();
    });

    it("handles restart error", async () => {
        vi.mocked(invoke).mockRejectedValue("ADB restart failed");
        await restartAdb();
        expect(state.error).toBe("ADB restart failed");
    });
});

describe("refreshAll", () => {
    it("resets state and triggers refresh", async () => {
        state.selectedSerial = "abc";
        await refreshAll();
        expect(state.loadingDevices).toBe(true);
        expect(state.loadingApps).toBe(true);
        expect(mockRender.updateErrorBanner).toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("trigger_refresh");
    });
});

describe("loadSettings", () => {
    it("loads settings and folders", async () => {
        const settings: SettingsState = {
            adbPath: "/usr/bin/adb",
            scrcpyPath: "/usr/bin/scrcpy",
            includeSystemApps: true,
            iconSource: "none",
            flexDisplay: false,
            webEnabled: false,
            adbFallback: false,
            killOnClose: false,
            displayBounds: "",
            deviceDisplayBounds: {},
            wirelessDevices: [],
            lastWirelessHost: "",
            lastWirelessPort: "5555",
            folders: { "abc": { games: { id: "games", name: "Games", apps: ["com.a"] } } },
            deviceNicknames: {},
            ignoredUpdateVersion: "",
            globalScrcpyArgs: "",
            deviceScrcpyArgs: {},
            appScrcpyArgs: {},
        };
        vi.mocked(invoke).mockResolvedValue(settings);
        await loadSettings();
        expect(state.settings).toEqual(settings);
        expect(state.folders).toEqual(settings.folders);
    });
});

describe("saveSettings", () => {
    it("reads form and saves settings", async () => {
        document.body.innerHTML = `
            <input id="adbPath" value="/custom/adb" />
            <input id="scrcpyPath" value="/custom/scrcpy" />
            <input id="includeSystemApps" type="checkbox" checked />
            <select id="iconSource"><option value="none" selected></option></select>
            <input id="flexDisplay" type="checkbox" />
            <input id="killOnClose" type="checkbox" checked />
            <input id="displayBounds" value="720x1280" />
        `;
        state.settings = {
            adbPath: "adb",
            scrcpyPath: "scrcpy",
            includeSystemApps: false,
            iconSource: "none",
            flexDisplay: false,
            webEnabled: false,
            adbFallback: false,
            killOnClose: false,
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
        vi.mocked(invoke).mockImplementation(async (_cmd: string, args?: any) => ({ ...args?.settings }));
        await saveSettings();
        expect(invoke).toHaveBeenCalled();
        const callArgs = vi.mocked(invoke).mock.calls[0][1] as any;
        expect(callArgs.settings.adbPath).toBe("/custom/adb");
        expect(callArgs.settings.includeSystemApps).toBe(true);
        expect(callArgs.settings.killOnClose).toBe(true);
    });
});

describe("beginLoadApps", () => {
    it("triggers app loading", () => {
        beginLoadApps("abc");
        expect(state.loadingApps).toBe(true);
        expect(mockRender.updateAppGrid).toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("trigger_load_apps", { serial: "abc" });
    });
});

describe("loadCachedMetaAndResolve", () => {
    it("fills from cache and resolves uncached", async () => {
        state.apps = [
            { packageName: "com.cached", label: "", iconUrl: undefined },
            { packageName: "com.uncached", label: "", iconUrl: undefined },
        ];
        vi.mocked(invoke).mockResolvedValue({
            "com.cached": { label: "Cached App", iconDataUrl: "data:png,abc", source: "web", resolvedAt: 1000 },
        });
        await loadCachedMetaAndResolve();
        expect(state.apps[0].label).toBe("Cached App");
        expect(state.apps[0].iconUrl).toBe("data:png,abc");
        expect(mockRender.updateAppGrid).toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("resolve_app_batch", {
            serial: "",
            pkgs: ["com.uncached"],
        });
    });

    it("skips resolve when all apps cached", async () => {
        state.apps = [{ packageName: "com.a", label: "" }];
        vi.mocked(invoke).mockResolvedValue({
            "com.a": { label: "A", iconDataUrl: null, source: "web", resolvedAt: 1000 },
        });
        await loadCachedMetaAndResolve();
        expect(invoke).not.toHaveBeenCalledWith("resolve_app_batch", expect.anything());
    });
});

describe("launchMirror", () => {
    it("launches mirror", async () => {
        vi.mocked(invoke).mockResolvedValue(undefined);
        await launchMirror("abc");
        expect(invoke).toHaveBeenCalledWith("launch_mirror", { serial: "abc" });
    });

    it("handles error", async () => {
        vi.mocked(invoke).mockRejectedValue("Launch failed");
        await launchMirror("abc");
        expect(state.error).toBe("Launch failed");
    });
});

describe("launch", () => {
    it("launches app successfully", async () => {
        const app: AndroidApp = { packageName: "com.test", label: "Test" };
        vi.mocked(invoke).mockResolvedValue({ usedFlexDisplay: false, message: "App started" });
        await launch(app);
        expect(invoke).toHaveBeenCalledWith("launch_app", {
            serial: "",
            packageName: "com.test",
            label: "Test",
        });
        expect(state.launchMessages.get("com.test")?.text).toBe("App started");
        expect(state.launchingPackage).toBe("");
    });

    it("handles launch failure", async () => {
        const app: AndroidApp = { packageName: "com.test", label: "Test" };
        vi.mocked(invoke).mockRejectedValue("Failed to launch");
        await launch(app);
        expect(state.launchMessages.get("com.test")?.kind).toBe("error");
        expect(state.openApps.has("com.test")).toBe(false);
    });
});
