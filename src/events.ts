import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { state } from "./state";
import type {
    ToolStatus,
    Device,
    AppsLoadedEvent,
    AppMetaResolvedEvent,
} from "./types";
import {
    selectedDevice,
    filteredApps,
    readyDeviceKey,
    iconSeed,
    initials,
} from "./utils";
import {
    initShell,
    updateAppGrid,
    updateTopBar,
    updateWirelessForm,
    updateErrorBanner,
    updateSettings,
    updateControlRow,
    updateOpenStatus,
    updateFocusedApp,
    updateShellDeviceSerial,
    updateCardElement,
    renderContextMenu,
    openFolder,
    closeCreateFolderModal,
    showConnectionGuide,
} from "./render";
import {
    doWirelessConnect,
    doWirelessDisconnect,
    doWirelessReconnect,
    refreshAll,
    saveSettings,
    restartAdb,
    launchMirror,
    launch,
    beginLoadApps,
    loadCachedMetaAndResolve,
    fetchNotificationCounts,
    confirmCreateFolder,
    createFolderPrompt,
    addToFolder,
    removeFromFolder,
    deleteFolder,
    closeSettings,
    loadSettings,
    loadWirelessDevices,
    installScrcpyWindows,
} from "./actions";

export function setupEventDelegation(): void {
    const app = document.querySelector<HTMLDivElement>("#app")!;

    app.addEventListener("contextmenu", (event) => {
        const target = event.target as HTMLElement;

        const folderCard = target.closest("[data-folder-id]");
        if (folderCard && !folderCard.closest("[data-package]")) {
            event.preventDefault();
            const id = (folderCard as HTMLElement).dataset.folderId!;
            const devFolders = state.folders[state.selectedSerial] ?? {};
            const name = devFolders[id]?.name ?? "folder";
            state.contextMenu = {
                x: event.clientX,
                y: event.clientY,
                folderId: id,
                folderName: name,
            };
            renderContextMenu();
            return;
        }

        const card = target.closest("[data-package]");
        if (card) {
            event.preventDefault();
            state.contextMenu = {
                x: event.clientX,
                y: event.clientY,
                pkg: (card as HTMLElement).dataset.package!,
            };
            renderContextMenu();
        } else {
            state.contextMenu = null;
            renderContextMenu();
        }
    });

    app.addEventListener("click", (event) => {
        // Context menu item click — handle BEFORE outside-dismiss
        if (state.contextMenu) {
            const item = (event.target as HTMLElement).closest(".menu-item");
            if (item) {
                const action = item.getAttribute("data-action");
                const pkgValue = item.getAttribute("data-pkg")!;
                if (action === "create-folder") {
                    void createFolderPrompt(pkgValue);
                } else if (action === "add-to-folder") {
                    const folderId = item.getAttribute("data-folder-id")!;
                    void addToFolder(folderId, pkgValue);
                } else if (action === "remove-from-folder") {
                    const folderId = item.getAttribute("data-folder-id")!;
                    if (folderId) void removeFromFolder(folderId, pkgValue);
                } else if (action === "delete-folder") {
                    const folderId = item.getAttribute("data-folder-id")!;
                    if (folderId) void deleteFolder(folderId);
                }
                state.contextMenu = null;
                renderContextMenu();
                return;
            }
        }

        if (state.contextMenu) {
            const target = event.target as HTMLElement;
            if (!target.closest(".context-menu")) {
                state.contextMenu = null;
                renderContextMenu();
            }
        }

        const t0 = event.target as HTMLElement;
        if (t0.closest("#closeGuideModal") || (t0.closest("#guide-modal") && t0.classList.contains("modal-overlay"))) {
            document.getElementById("guide-modal")?.classList.remove("open");
            return;
        }

        if ((event.target as HTMLElement).closest("#closeFolderModal") || 
            (event.target as HTMLElement).classList.contains("modal-overlay")) {
            openFolder(null);
            return;
        }

        const removeApp = (event.target as HTMLElement).closest("[data-remove-app]");
        if (removeApp) {
            const pkg = (removeApp as HTMLElement).dataset.removeApp!;
            const id = state.currentFolderId;
            if (id) void removeFromFolder(id, pkg);
            return;
        }

        const delFolder = (event.target as HTMLElement).closest("#deleteFolderBtn");
        if (delFolder) {
            const id = state.currentFolderId;
            if (id) void deleteFolder(id);
            return;
        }

        if (state.createFolderPkg) {
            const t = event.target as HTMLElement;
            if (t.closest("#closeCreateFolder") || t.closest("#cancelCreateFolder") || t.classList.contains("modal-overlay")) {
                closeCreateFolderModal();
                return;
            }
            if (t.closest("#confirmCreateFolder")) {
                void confirmCreateFolder();
                return;
            }
        }

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
            state.wirelessHost = "";
            state.wirelessPort = "5555";
            state.wirelessConnecting = false;
            state.wirelessConnectResult = null;
            state.wirelessConnectMsg = "";
            updateWirelessForm();
            if (state.wirelessConnectOpen) {
                setTimeout(
                    () => document.getElementById("wirelessHost")?.focus(),
                    0,
                );
            }
            return;
        }

        const folderCard = target.closest(".folder-card");
        if (folderCard) {
            const id = (folderCard as HTMLElement).dataset.folderId;
            if (id) {
                openFolder(id === "favorites" ? "favorites" : id);
            }
            return;
        }

        if (target.closest("#closeWirelessForm")) {
            state.wirelessConnectOpen = false;
            state.wirelessConnectResult = null;
            state.wirelessConnectMsg = "";
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

        const mirrorBtn = target.closest("[data-mirror]");
        if (mirrorBtn) {
            const serial = (mirrorBtn as HTMLElement).dataset.mirror!;
            void launchMirror(serial);
            return;
        }

        const deviceCard = target.closest(".device-card");
        if (deviceCard) {
            const serial = (deviceCard as HTMLElement).dataset.serial!;
            if (serial !== state.selectedSerial) {
                state.selectedSerial = serial;
                beginLoadApps(serial);
            }
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

        if (target.closest("#adbRestart")) {
            void restartAdb();
            return;
        }

        if (target.closest("#scanDevices")) {
            void refreshAll();
            return;
        }

        if (target.closest("#showGuide")) {
            showConnectionGuide();
            return;
        }

        if (target.closest("#installScrcpyWindows")) {
            void installScrcpyWindows();
            return;
        }

        if (target.closest("#clearSearch")) {
            state.query = "";
            const searchInput = document.getElementById("search") as HTMLInputElement | null;
            if (searchInput) searchInput.value = "";
            updateAppGrid();
            return;
        }
    });

    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    app.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input.id === "search") {
            state.query = input.value;
            if (searchDebounce) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => updateAppGrid(), 150);
        }
        if (input.id === "wirelessHost") {
            state.wirelessHost = input.value;
            state.wirelessConnectResult = null;
            state.wirelessConnectMsg = "";
        }
        if (input.id === "wirelessPort") {
            state.wirelessPort = input.value;
            state.wirelessConnectResult = null;
            state.wirelessConnectMsg = "";
        }
    });

    window.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        const activeEl = document.activeElement;
        const isInput = activeEl instanceof HTMLInputElement;

        if (
            key === "Enter" &&
            state.wirelessConnectOpen &&
            !state.wirelessConnecting &&
            state.wirelessConnectResult !== "ok" &&
            isInput &&
            ((activeEl as HTMLInputElement).id === "wirelessHost" || (activeEl as HTMLInputElement).id === "wirelessPort")
        ) {
            void doWirelessConnect();
        } else if (
            key === "Enter" &&
            !isInput &&
            state.focusedAppIndex !== null
        ) {
            const apps = filteredApps();
            const item = apps[state.focusedAppIndex];
            if (item) void launch(item);
        }

        if (
            key === "Enter" &&
            state.createFolderPkg &&
            isInput &&
            (activeEl as HTMLInputElement).id === "createFolderName"
        ) {
            void confirmCreateFolder();
        }

        if (key === "Escape" && state.createFolderPkg) {
            closeCreateFolderModal();
        }

        if (key === "Backspace" && state.query !== "") {
            const searchInput = document.getElementById("search") as HTMLInputElement | null;
            const activeEl = document.activeElement;
            if (searchInput && activeEl !== searchInput && !(activeEl instanceof HTMLInputElement)) {
                state.query = "";
                searchInput.value = "";
                updateAppGrid();
            }
        }

        if (!isInput) {
            if (key === "ArrowRight" || key === "ArrowDown") {
                const apps = filteredApps();
                if (apps.length > 0) {
                    state.focusedAppIndex = state.focusedAppIndex === null 
                        ? 0 
                        : (state.focusedAppIndex + 1) % apps.length;
                    updateFocusedApp();
                }
            } else if (key === "ArrowLeft" || key === "ArrowUp") {
                const apps = filteredApps();
                if (apps.length > 0) {
                    state.focusedAppIndex = state.focusedAppIndex === null 
                        ? apps.length - 1 
                        : (state.focusedAppIndex - 1 + apps.length) % apps.length;
                    updateFocusedApp();
                }
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

export async function init(): Promise<void> {
    try {
        window.addEventListener("error", (event) => {
            state.error = event.message || "A frontend error occurred.";
            updateErrorBanner();
        });
        window.addEventListener("unhandledrejection", (event) => {
            state.error = String(event.reason || "An async frontend error occurred.");
            updateErrorBanner();
        });

        setupEventDelegation();
        initShell();
        await loadSettings();
        updateSettings();

        const openApps = await invoke<string[]>("get_open_apps");
        state.openApps = new Set(openApps);
        updateAppGrid();

        window.addEventListener("scroll", () => {
            // updateStickyState is imported directly
            const row = document.querySelector<HTMLElement>(".control-row");
            const topbar = document.querySelector<HTMLElement>(".topbar");
            if (row && topbar) {
                row.classList.toggle(
                    "stuck",
                    topbar.getBoundingClientRect().bottom <= 0,
                );
            }
        }, { passive: true });

        await listen<ToolStatus>("tool-status-updated", (event) => {
            state.tools = event.payload;
            updateTopBar();
        });

        await listen<string[]>("open-apps-updated", (event) => {
            state.openApps = new Set(event.payload);
            updateOpenStatus();
        });

        let notifInterval: ReturnType<typeof setInterval> | null = null;
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

            if (
                !state.selectedSerial &&
                state.wirelessDevices.length === 0 &&
                !state.guideAutoShown
            ) {
                state.guideAutoShown = true;
                showConnectionGuide();
            }

            const selectedChanged = previousSerial !== state.selectedSerial;
            const devicesChanged = previousKey !== nextKey;

            if (!state.selectedSerial) {
                state.apps = [];
                state.resolveQueue = new Set();
                state.focusedAppIndex = null;
                state.notificationCounts = {};
                state.loadingApps = false;
                if (selectedChanged) {
                    state.error = "Device disconnected";
                    updateErrorBanner();
                }
                if (notifInterval) {
                    clearInterval(notifInterval);
                    notifInterval = null;
                }
                updateAppGrid();
                updateControlRow();
            } else if (selectedChanged || devicesChanged) {
                beginLoadApps(state.selectedSerial);
            }
        });

        await listen<AppsLoadedEvent>("apps-loaded", (event) => {
            const { serial, apps } = event.payload;
            if (serial !== state.selectedSerial) return;
            state.apps = apps;
            state.loadingApps = false;
            updateAppGrid();
            loadCachedMetaAndResolve();
            fetchNotificationCounts();
            if (notifInterval) clearInterval(notifInterval);
            notifInterval = setInterval(fetchNotificationCounts, 30000);
        });

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

        await listen("app-meta-batch-complete", () => {
            state.resolveQueue.clear();
            updateControlRow();
            console.log("[meta] batch complete");
        });

        invoke("trigger_refresh");
    } catch (error) {
        state.error = String(error);
        updateErrorBanner();
    }
}
