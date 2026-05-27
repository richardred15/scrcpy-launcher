import type { SettingsState, ToolStatus, Device, AndroidApp, CachedAppMeta, Folder, MdnsDiscoveredDevice } from "./types";

export function stableIdForSerial(serial: string): string {
    const device = state.devices.find(d => d.serial === serial);
    return device?.stableId ?? serial;
}

export type AppState = {
    settings: SettingsState | null;
    tools: ToolStatus | null;
    devices: Device[];
    selectedSerial: string;
    apps: AndroidApp[];
    cacheMeta: Map<string, CachedAppMeta> | null;
    resolveQueue: Set<string>;
    query: string;
    loadingDevices: boolean;
    loadingApps: boolean;
    settingsOpen: boolean;
    error: string;
    wirelessConnectOpen: boolean;
    wirelessHost: string;
    wirelessPort: string;
    wirelessConnecting: boolean;
    wirelessConnectResult: "ok" | "error" | null;
    wirelessConnectMsg: string;
    wirelessDevices: string[];
    openApps: Set<string>;
    folders: Record<string, Record<string, Folder>>;
    currentFolderId: string | null;
    focusedAppIndex: number | null;
    launchingPackage: string;
    launchMessages: Map<string, { kind: "info" | "error"; text: string }>;
    contextMenu: { x: number; y: number; pkg?: string; folderId?: string; folderName?: string; deviceStableId?: string } | null;
    notificationCounts: Record<string, number>;
    createFolderPkg: string;
    dragSourcePkg: string;
    pendingDragPkg: string;
    renameDeviceStableId: string;
    renameFolderId: string;
    renameFolderName: string;
    scrcpyArgsId: string;
    scrcpyArgsType: "device" | "app" | null;
    scrcpyArgsValue: string;
    pairingHostPort: string;
    pairingCode: string;
    guideAutoShown: boolean;
    discoveredDevices: MdnsDiscoveredDevice[];
    scanningNetwork: boolean;
};

export function createState(): AppState {
    return {
        settings: null,
        tools: null,
        devices: [],
        selectedSerial: "",
        apps: [],
        cacheMeta: null,
        resolveQueue: new Set(),
        query: "",
        loadingDevices: true,
        loadingApps: false,
        settingsOpen: false,
        error: "",
        wirelessConnectOpen: false,
        wirelessHost: "",
        wirelessPort: "5555",
        wirelessConnecting: false,
        wirelessConnectResult: null,
        wirelessConnectMsg: "",
        wirelessDevices: [],
        openApps: new Set(),
        folders: {},
        currentFolderId: null,
        focusedAppIndex: null,
        launchingPackage: "",
        launchMessages: new Map(),
        contextMenu: null,
        notificationCounts: {},
        createFolderPkg: "",
        dragSourcePkg: "",
        pendingDragPkg: "",
        renameDeviceStableId: "",
        renameFolderId: "",
        renameFolderName: "",
        scrcpyArgsId: "",
        scrcpyArgsType: null,
        scrcpyArgsValue: "",
        pairingHostPort: "",
        pairingCode: "",
        guideAutoShown: false,
        discoveredDevices: [],
        scanningNetwork: false,
    };
}

export const state = createState();

export function resetState(): void {
    Object.assign(state, createState());
}
