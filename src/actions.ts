import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import type { AndroidApp, SettingsState, LaunchResult, CachedAppMeta } from "./types";
import { isFavorited } from "./utils";
import {
    updateAppGrid,
    updateErrorBanner,
    updateTopBar,
    updateWirelessForm,
    updateSettings,
    updateControlRow,
    updateOpenStatus,
    updateNotificationBadges,
    renderContextMenu,
    closeCreateFolderModal,
    openCreateFolderModal,
} from "./render";

export async function fetchNotificationCounts(): Promise<void> {
    if (!state.selectedSerial) return;
    try {
        state.notificationCounts = await invoke<Record<string, number>>(
            "get_notification_counts",
            { serial: state.selectedSerial },
        );
        updateNotificationBadges();
    } catch {
        // best effort
    }
}

export async function addToFolder(folderId: string, pkg: string): Promise<void> {
    try {
        if (folderId === "favorites" && isFavorited(pkg)) {
            await invoke("remove_app_from_folder", { folderId, packageName: pkg });
            const folder = state.folders["favorites"];
            if (folder) {
                folder.apps = folder.apps.filter(p => p !== pkg);
            }
        } else {
            await invoke("add_app_to_folder", { folderId, packageName: pkg });
            const folder = state.folders[folderId];
            if (folder && !folder.apps.includes(pkg)) {
                folder.apps.push(pkg);
            } else if (folderId === "favorites") {
                state.folders[folderId] = { id: folderId, name: "Favorites", apps: [pkg] };
            }
        }
        updateAppGrid();
    } catch (e: any) {
        state.error = String(e);
        updateErrorBanner();
    }
}

export async function confirmCreateFolder(): Promise<void> {
    const input = document.getElementById("createFolderName") as HTMLInputElement;
    const name = input?.value.trim();
    if (!name) {
        input?.focus();
        return;
    }
    const pkg = state.createFolderPkg;
    closeCreateFolderModal();
    try {
        const id = await invoke<string>("create_folder", { name });
        state.folders[id] = { id, name, apps: [] };
        state.contextMenu = null;
        renderContextMenu();
        await addToFolder(id, pkg);
    } catch (e: any) {
        state.error = String(e);
        updateErrorBanner();
    }
}

export async function createFolderPrompt(pkg: string): Promise<void> {
    openCreateFolderModal(pkg);
}

export async function doWirelessConnect(): Promise<void> {
    const host = state.wirelessHost.trim();
    const port = state.wirelessPort.trim();
    if (!host) {
        state.wirelessConnectResult = "error";
        state.wirelessConnectMsg = "IP address is required";
        updateWirelessForm();
        return;
    }
    const portNum = port ? parseInt(port, 10) : 5555;
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        state.wirelessConnectResult = "error";
        state.wirelessConnectMsg = "Port must be a number between 1 and 65535";
        updateWirelessForm();
        return;
    }
    const hostPort = `${host}:${portNum}`;
    state.wirelessConnecting = true;
    state.wirelessConnectResult = null;
    state.wirelessConnectMsg = "";
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
            state.wirelessConnecting = false;
            state.wirelessConnectResult = "ok";
            state.wirelessConnectMsg = "";
            updateWirelessForm();
            await new Promise((r) => setTimeout(r, 1000));
            state.wirelessConnectOpen = false;
            state.wirelessHost = "";
            state.wirelessPort = "5555";
            state.wirelessConnectResult = null;
            state.wirelessConnectMsg = "";
            await refreshAll();
            await loadWirelessDevices();
        } else {
            state.wirelessConnectResult = "error";
            state.wirelessConnectMsg = result;
            state.wirelessConnecting = false;
            updateWirelessForm();
        }
    } catch (e: any) {
        state.wirelessConnectResult = "error";
        state.wirelessConnectMsg = typeof e === "string" ? e : String(e);
        state.wirelessConnecting = false;
        updateWirelessForm();
    }
}

export async function doWirelessDisconnect(hostPort: string): Promise<void> {
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

export async function doWirelessReconnect(hostPort: string): Promise<void> {
    state.error = "";
    state.wirelessConnectResult = null;
    state.wirelessConnectMsg = "";
    updateWirelessForm();
    updateErrorBanner();
    try {
        const result = await invoke<string>("adb_connect", { hostPort });
        if (
            result.includes("already connected") ||
            result.includes("connected to")
        ) {
            await refreshAll();
        } else {
            state.error = result;
            updateErrorBanner();
        }
    } catch (e: any) {
        state.error = String(e);
        updateErrorBanner();
    }
}

export async function loadWirelessDevices(): Promise<void> {
    try {
        state.wirelessDevices = await invoke<string[]>("get_wireless_devices");
        updateSettings();
    } catch {
        state.wirelessDevices = [];
        updateSettings();
    }
}

export async function closeSettings(): Promise<void> {
    state.settingsOpen = false;
    updateSettings();
}

export async function restartAdb(): Promise<void> {
    state.error = "";
    updateErrorBanner();
    try {
        await invoke("adb_restart_server");
    } catch (e: any) {
        state.error = String(e);
        updateErrorBanner();
        return;
    }
    state.loadingDevices = true;
    state.loadingApps = true;
    updateTopBar();
    invoke("trigger_refresh");
    if (state.selectedSerial) beginLoadApps(state.selectedSerial);
    loadWirelessDevices();
}

export async function refreshAll(): Promise<void> {
    state.error = "";
    state.loadingDevices = true;
    state.loadingApps = true;
    updateTopBar();
    updateErrorBanner();
    invoke("trigger_refresh");
    if (state.selectedSerial) beginLoadApps(state.selectedSerial);
    loadWirelessDevices();
}

export async function loadSettings(): Promise<void> {
    state.settings = await invoke<SettingsState>("get_settings");
    state.folders = state.settings?.folders || {};
}

export async function saveSettings(): Promise<void> {
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

export function beginLoadApps(serial: string): void {
    state.loadingApps = true;
    state.error = "";
    updateAppGrid();
    invoke("trigger_load_apps", { serial });
}

export async function loadCachedMetaAndResolve(): Promise<void> {
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

export async function launchMirror(serial: string): Promise<void> {
    try {
        await invoke("launch_mirror", { serial });
    } catch (error) {
        state.error = String(error);
        updateErrorBanner();
    }
}

export async function launch(item: AndroidApp): Promise<void> {
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
