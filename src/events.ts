import { version } from "../package.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { state, stableIdForSerial } from "./state";
import type {
    ToolStatus,
    Device,
    AppsLoadedEvent,
    AppMetaResolvedEvent,
    MdnsDiscoveredDevice,
} from "./types";
import {
    filteredApps,
    iconSeed,
    initials,
} from "./utils";
import {
    initShell,
    updateAppGrid,
    updateTopBar,
    updateDeviceDropdown,
    updateWirelessForm,
    updateErrorBanner,
    updateSettings,
    updateControlRow,
    updateStickyState,
    updateOpenStatus,
    updateFocusedApp,
    updateCardElement,
    renderContextMenu,
    openFolder,
    closeCreateFolderModal,
    openRenameDeviceModal,
    closeRenameDeviceModal,
    openRenameFolderModal,
    closeRenameFolderModal,
    openScrcpyArgsModal,
    closeScrcpyArgsModal,
    openPairingModal,
    closePairingModal,
    showConnectionGuide,
} from "./render";
import {
    doWirelessConnect,
    doWirelessDisconnect,
    doWirelessReconnect,
    refreshAll,
    doInstallApk,
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
    confirmRenameDevice,
    confirmRenameFolder,
    confirmSetScrcpyArgs,
    confirmPairing,
    closeSettings,
    loadSettings,
    loadWirelessDevices,
    installScrcpyWindows,
    checkForUpdates,
    dismissUpdate,
} from "./actions";

export function setupEventDelegation(): void {
    const app = document.querySelector<HTMLDivElement>("#app")!;

    app.addEventListener("dragover", (event) => {
        event.preventDefault();
    });

    getCurrentWindow().listen("tauri://drag-drop", (event) => {
        const paths = (event.payload as string[]);
        if (!paths || paths.length === 0) return;

        const path = paths[0];
        if (!path.toLowerCase().endsWith(".apk")) {
            state.error = "Only .apk files are supported";
            updateErrorBanner();
            return;
        }

        void doInstallApk(path);
    });

    app.addEventListener("contextmenu", (event) => {
        const target = event.target as HTMLElement;

        const folderCard = target.closest("[data-folder-id]");
        if (folderCard && !folderCard.closest("[data-package]")) {
            event.preventDefault();
            const id = (folderCard as HTMLElement).dataset.folderId!;
            const devFolders = state.folders[stableIdForSerial(state.selectedSerial)] ?? {};
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

        const devicePill = target.closest(".device-pill");
        if (devicePill) {
            event.preventDefault();
            const option = target.closest(".device-pill-option");
            const serial = option
                ? (option as HTMLElement).dataset.serial!
                : state.selectedSerial;
            const device = state.devices.find(d => d.serial === serial);
            const stableId = device?.stableId ?? serial;
            state.contextMenu = {
                x: event.clientX,
                y: event.clientY,
                deviceStableId: stableId,
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

    app.addEventListener("click", async (event) => {
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
                } else if (action === "rename-device") {
                    const stableId = item.getAttribute("data-stable-id")!;
                    openRenameDeviceModal(stableId);
                } else if (action === "rename-folder") {
                    const folderId = item.getAttribute("data-folder-id")!;
                    const folderName = item.getAttribute("data-folder-name") ?? "";
                    openRenameFolderModal(folderId, folderName);
                } else if (action === "set-device-args") {
                    const stableId = item.getAttribute("data-stable-id")!;
                    const currentArgs = state.settings?.deviceScrcpyArgs[stableId] ?? "";
                    openScrcpyArgsModal(stableId, "device", currentArgs);
                } else if (action === "set-app-args") {
                    const pkg = item.getAttribute("data-pkg")!;
                    const currentArgs = state.settings?.appScrcpyArgs[pkg] ?? "";
                    openScrcpyArgsModal(pkg, "app", currentArgs);
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
            ((event.target as HTMLElement).classList.contains("modal-overlay") && (event.target as HTMLElement).closest("#folder-modal"))) {
            openFolder(null);
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

        if (state.renameDeviceStableId) {
            const t = event.target as HTMLElement;
            if (t.closest("#closeRenameDevice") || t.closest("#cancelRenameDevice") || t.classList.contains("modal-overlay")) {
                closeRenameDeviceModal();
                return;
            }
            if (t.closest("#confirmRenameDevice")) {
                void confirmRenameDevice();
                return;
            }
        }

        if (state.renameFolderId) {
            const t = event.target as HTMLElement;
            if (t.closest("#closeRenameFolder") || t.closest("#cancelRenameFolder") || t.classList.contains("modal-overlay")) {
                closeRenameFolderModal();
                return;
            }
            if (t.closest("#confirmRenameFolder")) {
                void confirmRenameFolder();
                return;
            }
        }

        if (state.scrcpyArgsId) {
            const t = event.target as HTMLElement;
            if (t.closest("#closeScrcpyArgs") || t.closest("#cancelScrcpyArgs") || t.classList.contains("modal-overlay")) {
                closeScrcpyArgsModal();
                return;
            }
            if (t.closest("#confirmScrcpyArgs")) {
                void confirmSetScrcpyArgs();
                return;
            }
        }

        if (state.pairingHostPort) {
            const t = event.target as HTMLElement;
            if (t.closest("#closePairing") || t.closest("#cancelPairing") || t.classList.contains("modal-overlay")) {
                closePairingModal();
                return;
            }
            if (t.closest("#confirmPairing")) {
                void confirmPairing();
                return;
            }
        }

        const updateModal = document.getElementById("update-modal");
        if (updateModal?.classList.contains("open")) {
            const t = event.target as HTMLElement;
            if (t.closest("#closeUpdateModal") || (t.closest("#update-modal") && t.classList.contains("modal-overlay"))) {
                updateModal.classList.remove("open");
                return;
            }
            if (t.closest("#ignoreUpdate")) {
                const ver = (t.closest("#ignoreUpdate") as HTMLElement).getAttribute("data-version");
                if (ver) void dismissUpdate(ver);
                updateModal.classList.remove("open");
                return;
            }
            if (t.closest("#downloadUpdate")) {
                updateModal.classList.remove("open");
                window.open("https://github.com/richardred15/scrcpy-launcher/releases/latest", "_blank");
                return;
            }
        }

        const target = event.target as HTMLElement;
        if (target.closest("#titlebarMinimize")) {
            getCurrentWindow().minimize();
            return;
        }
        if (target.closest("#titlebarMaximize")) {
            getCurrentWindow().toggleMaximize();
            return;
        }
        if (target.closest("#titlebarClose")) {
            getCurrentWindow().close();
            return;
        }
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

        const pairMdns = target.closest("[data-pair-mdns]");
        if (pairMdns) {
            const hostPort = (pairMdns as HTMLElement).getAttribute("data-pair-mdns")!;
            openPairingModal(hostPort);
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

        const option = target.closest(".device-pill-option");
        if (option) {
            const serial = (option as HTMLElement).dataset.serial!;
            if (serial !== state.selectedSerial) {
                state.selectedSerial = serial;
                updateTopBar();
                beginLoadApps(serial);
            }
            document.querySelector(".device-pill-dropdown")?.classList.remove("open");
            return;
        }

        const trigger = target.closest(".device-pill-trigger");
        if (trigger) {
            document.querySelector(".device-pill-dropdown")?.classList.toggle("open");
            return;
        }

        if (!target.closest(".device-pill")) {
            document.querySelector(".device-pill-dropdown")?.classList.remove("open");
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
            state.scanningNetwork = true;
            updateAppGrid();
            invoke("trigger_scan");
            return;
        }

        const mdnsConnect = (target as HTMLElement).closest("[data-connect-mdns]");
        if (mdnsConnect) {
            const hostPort = (mdnsConnect as HTMLElement).getAttribute("data-connect-mdns");
            if (hostPort) {
                state.wirelessHost = hostPort.split(":")[0];
                state.wirelessPort = hostPort.split(":")[1] || "5555";
                state.wirelessConnectOpen = true;
                updateWirelessForm();
                void doWirelessConnect();
            }
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

        if (target.closest("#installApk")) {
            const file = await open({
                multiple: false,
                filters: [{ name: "APK", extensions: ["apk"] }],
            });
            if (file && typeof file === "string") {
                void doInstallApk(file);
            }
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
        if (input.id === "pairingCode") {
            state.pairingCode = input.value;
        }
        if (input.id === "scrcpyArgsInput") {
            state.scrcpyArgsValue = input.value;
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
            state.pairingHostPort &&
            isInput &&
            (activeEl as HTMLInputElement).id === "pairingCode"
        ) {
            void confirmPairing();
        } else if (
            key === "Enter" &&
            !isInput &&
            state.focusedAppIndex !== null
        ) {
            const apps = filteredApps();
            const item = apps[state.focusedAppIndex];
            if (item) void launch(item);
        }

        if (key === "Escape") {
            if (state.pairingHostPort) {
                closePairingModal();
            } else if (state.scrcpyArgsId) {
                closeScrcpyArgsModal();
            } else if (state.renameFolderId) {
                closeRenameFolderModal();
            } else if (state.renameDeviceStableId) {
                closeRenameDeviceModal();
            } else if (state.createFolderPkg) {
                closeCreateFolderModal();
            } else if (state.currentFolderId) {
                openFolder(null);
            } else if (state.contextMenu) {
                state.contextMenu = null;
                renderContextMenu();
            } else if (state.wirelessConnectOpen) {
                state.wirelessConnectOpen = false;
                updateWirelessForm();
            } else if (state.settingsOpen) {
                closeSettings();
            } else if (!isInput) {
                const guide = document.getElementById("guide-modal");
                if (guide?.classList.contains("open")) {
                    guide.classList.remove("open");
                }
                const update = document.getElementById("update-modal");
                if (update?.classList.contains("open")) {
                    update.classList.remove("open");
                }
            }
            return;
        }

        if ((key === "r" || key === "R") && (event as KeyboardEvent).ctrlKey) {
            event.preventDefault();
            void refreshAll();
            return;
        }

        if ((key === "f" || key === "F") && (event as KeyboardEvent).ctrlKey) {
            event.preventDefault();
            const searchInput = document.getElementById("search") as HTMLInputElement | null;
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
            return;
        }

        if (
            key === "Enter" &&
            state.createFolderPkg &&
            isInput &&
            (activeEl as HTMLInputElement).id === "createFolderName"
        ) {
            void confirmCreateFolder();
        }

        if (
            key === "Enter" &&
            state.renameDeviceStableId &&
            isInput &&
            (activeEl as HTMLInputElement).id === "renameDeviceName"
        ) {
            void confirmRenameDevice();
        }

        if (
            key === "Enter" &&
            state.renameFolderId &&
            isInput &&
            (activeEl as HTMLInputElement).id === "renameFolderName"
        ) {
            void confirmRenameFolder();
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
        if (img.classList.contains("app-icon")) {
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
            return;
        }
        if (img.classList.contains("folder-preview-icon")) {
            const pkg = img.dataset.package;
            const item = pkg
                ? state.apps.find((a) => a.packageName === pkg)
                : undefined;
            if (!item) return;
            const fallback = document.createElement("div");
            fallback.className = "folder-preview-icon fallback";
            fallback.style.background = iconSeed(item.packageName);
            fallback.dataset.package = pkg;
            img.replaceWith(fallback);
        }
    });

    // Drag-and-drop for folder management
    app.addEventListener("dragstart", (event) => {
        const card = (event.target as HTMLElement).closest("[data-package]");
        if (!card) return;
        const pkg = (card as HTMLElement).dataset.package!;
        if (!pkg) return;
        const dt = event.dataTransfer;
        if (!dt) return;
        dt.effectAllowed = "move";
        dt.setData("text/plain", pkg);
        dt.setDragImage(card, 32, 32);
        state.dragSourcePkg = pkg;
        card.classList.add("dragging");
    });

    app.addEventListener("dragend", () => {
        state.dragSourcePkg = "";
        document.querySelectorAll(".dragging, .drag-over").forEach(el => {
            el.classList.remove("dragging", "drag-over");
        });
    });

    app.addEventListener("dragover", (event) => {
        const target = event.target as HTMLElement;
        const appCard = target.closest(".app-card");
        const folderCard = target.closest(".folder-card");
        const modal = target.closest("#folder-modal");
        if (!appCard && !folderCard && !modal) return;
        event.preventDefault();
        event.dataTransfer!.dropEffect = "move";
        document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        if (appCard && (appCard as HTMLElement).dataset.package !== state.dragSourcePkg) {
            appCard.classList.add("drag-over");
        } else if (folderCard) {
            folderCard.classList.add("drag-over");
        } else if (modal) {
            modal.classList.add("drag-over");
        }
    });

    app.addEventListener("dragleave", (event) => {
        const target = event.target as HTMLElement;
        const related = event.relatedTarget as HTMLElement | null;
        const appCard = target.closest(".app-card");
        const folderCard = target.closest(".folder-card");
        const modal = target.closest("#folder-modal");
        if (appCard && (!related || !appCard.contains(related))) {
            appCard.classList.remove("drag-over");
        } else if (folderCard && (!related || !folderCard.contains(related))) {
            folderCard.classList.remove("drag-over");
        } else if (modal && (!related || !modal.contains(related))) {
            modal.classList.remove("drag-over");
        }
    });

    app.addEventListener("drop", (event) => {
        event.preventDefault();
        const pkg = event.dataTransfer?.getData("text/plain");
        if (!pkg) return;
        document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        const target = event.target as HTMLElement;
        // Drop on folder card → add to folder
        const folderCard = target.closest(".folder-card");
        if (folderCard) {
            const folderId = (folderCard as HTMLElement).dataset.folderId;
            if (folderId) void addToFolder(folderId, pkg);
            return;
        }
        // Drop inside folder modal → remove from folder if app is in current folder
        const folderModal = target.closest("#folder-modal");
        if (folderModal && state.currentFolderId && state.currentFolderId !== "favorites") {
            const sid = stableIdForSerial(state.selectedSerial);
            const folders = state.folders[sid] ?? {};
            const folder = folders[state.currentFolderId];
            if (folder && folder.apps.includes(pkg)) {
                void removeFromFolder(state.currentFolderId, pkg);
                return;
            }
        }
        // Drop on another app card → create folder with both apps
        const appCard = target.closest(".app-card");
        if (appCard) {
            const targetPkg = (appCard as HTMLElement).dataset.package;
            if (targetPkg && targetPkg !== pkg) {
                state.pendingDragPkg = pkg;
                state.contextMenu = null;
                renderContextMenu();
                void createFolderPrompt(targetPkg);
            }
        }
    });
}

async function checkForUpdatesAndShow(): Promise<void> {
    const latest = await checkForUpdates();
    if (!latest) return;
    const modal = document.getElementById("update-modal");
    if (!modal) return;
    const msg = document.getElementById("updateMessage");
    if (msg) msg.textContent = `scrcpy Launcher ${latest} is available. You're on v${version}. Would you like to download the update?`;
    const ignoreBtn = document.getElementById("ignoreUpdate");
    if (ignoreBtn) ignoreBtn.setAttribute("data-version", latest);
    modal.classList.add("open");
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
        await checkForUpdatesAndShow();

        const openApps = await invoke<string[]>("get_open_apps");
        state.openApps = new Set(openApps);
        updateAppGrid();

        window.addEventListener("scroll", updateStickyState, { passive: true });

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
            state.devices = devices;
            state.loadingDevices = false;

            const ready = devices.filter((d) => d.state === "device");
            if (ready.length === 1) {
                state.selectedSerial = ready[0].serial;
            } else if (!ready.some((d) => d.serial === state.selectedSerial)) {
                state.selectedSerial = ready[0]?.serial || "";
            }

            const selectedChanged = previousSerial !== state.selectedSerial;

            if (selectedChanged) {
                updateTopBar();
                if (!state.selectedSerial) {
                    state.apps = [];
                    state.resolveQueue = new Set();
                    state.focusedAppIndex = null;
                    state.notificationCounts = {};
                    state.loadingApps = false;
                    state.error = "Device disconnected";
                    updateErrorBanner();
                    if (notifInterval) {
                        clearInterval(notifInterval);
                        notifInterval = null;
                    }
                    updateAppGrid();
                    updateControlRow();
                } else {
                    if (state.error) {
                        state.error = "";
                        updateErrorBanner();
                    }
                    beginLoadApps(state.selectedSerial);
                }
            } else {
                updateDeviceDropdown();
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
                    `.app-card[data-package="${packageName}"]`,
                );
                if (card) updateCardElement(card, app);
                document.querySelectorAll<HTMLElement>(
                    `.folder-preview-icon[data-package="${packageName}"]`,
                ).forEach(el => {
                    if (iconUrl) {
                        const img = document.createElement("img");
                        img.className = "folder-preview-icon";
                        img.src = iconUrl;
                        img.dataset.package = packageName;
                        el.replaceWith(img);
                    }
                });
                updateControlRow();
            }
        });

        await listen("app-meta-batch-complete", () => {
            state.resolveQueue.clear();
            updateControlRow();
        });

        await listen<MdnsDiscoveredDevice[]>("wireless-scan-result", (event) => {
            state.discoveredDevices = event.payload;
            state.scanningNetwork = false;
            updateAppGrid();
            if (
                !state.selectedSerial &&
                state.wirelessDevices.length === 0 &&
                state.discoveredDevices.length === 0 &&
                !state.guideAutoShown
            ) {
                state.guideAutoShown = true;
                showConnectionGuide();
            }
        });

        await listen<{ success: boolean; message: string }>("apk-install-result", (event) => {
            const { success, message } = event.payload;
            if (success) {
                state.error = "";
                updateErrorBanner();
                if (state.selectedSerial) beginLoadApps(state.selectedSerial);
            } else {
                state.error = `Installation failed: ${message}`;
                updateErrorBanner();
            }
        });

        invoke("trigger_refresh");
    } catch (error) {
        state.error = String(error);
        updateErrorBanner();
    }
}
