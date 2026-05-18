import { describe, it, expect } from "vitest";
import { createState, resetState, state } from "./state";

describe("createState", () => {
    it("returns default values", () => {
        const s = createState();
        expect(s.settings).toBeNull();
        expect(s.tools).toBeNull();
        expect(s.devices).toEqual([]);
        expect(s.selectedSerial).toBe("");
        expect(s.apps).toEqual([]);
        expect(s.cacheMeta).toBeNull();
        expect(s.resolveQueue).toEqual(new Set());
        expect(s.appLoadToken).toBe(0);
        expect(s.lastReadyDeviceKey).toBe("");
        expect(s.query).toBe("");
        expect(s.loadingDevices).toBe(true);
        expect(s.loadingApps).toBe(false);
        expect(s.loadingIcons).toBe(false);
        expect(s.settingsOpen).toBe(false);
        expect(s.error).toBe("");
        expect(s.wirelessConnectOpen).toBe(false);
        expect(s.wirelessHost).toBe("");
        expect(s.wirelessPort).toBe("5555");
        expect(s.wirelessConnecting).toBe(false);
        expect(s.wirelessConnectResult).toBeNull();
        expect(s.wirelessConnectMsg).toBe("");
        expect(s.wirelessDevices).toEqual([]);
        expect(s.openApps).toEqual(new Set());
        expect(s.folders).toEqual({});
        expect(s.currentFolderId).toBeNull();
        expect(s.focusedAppIndex).toBeNull();
        expect(s.launchingPackage).toBe("");
        expect(s.launchMessages).toEqual(new Map());
        expect(s.contextMenu).toBeNull();
        expect(s.notificationCounts).toEqual({});
        expect(s.createFolderPkg).toBe("");
    });

    it("returns fresh mutable objects each call", () => {
        const a = createState();
        const b = createState();
        expect(a).not.toBe(b);
        expect(a.apps).not.toBe(b.apps);
        expect(a.devices).not.toBe(b.devices);
        expect(a.folders).not.toBe(b.folders);
        expect(a.openApps).not.toBe(b.openApps);
        expect(a.launchMessages).not.toBe(b.launchMessages);
        expect(a.wirelessDevices).not.toBe(b.wirelessDevices);
        expect(a.notificationCounts).not.toBe(b.notificationCounts);
    });

    it("Set and Map are empty, not null", () => {
        const s = createState();
        expect(s.resolveQueue.size).toBe(0);
        expect(s.openApps.size).toBe(0);
        expect(s.launchMessages.size).toBe(0);
    });
});

describe("resetState", () => {
    it("resets all fields to defaults", () => {
        state.selectedSerial = "abc123";
        state.apps = [{ packageName: "com.test", label: "Test", iconUrl: "x" }];
        state.query = "searching";
        state.error = "some error";

        resetState();

        expect(state.selectedSerial).toBe("");
        expect(state.apps).toEqual([]);
        expect(state.query).toBe("");
        expect(state.error).toBe("");
        expect(state.loadingDevices).toBe(true);
        expect(state.loadingApps).toBe(false);
    });

    it("does not replace the singleton reference", () => {
        const ref = state;
        resetState();
        expect(state).toBe(ref);
    });
});
