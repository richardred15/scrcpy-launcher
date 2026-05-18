import type { SettingsState, ToolStatus, Device, AndroidApp, CachedAppMeta, Folder } from "./types";

export type AppState = {
    settings: SettingsState | null;
    tools: ToolStatus | null;
    devices: Device[];
    selectedSerial: string;
    apps: AndroidApp[];
    cacheMeta: Map<string, CachedAppMeta> | null;
    resolveQueue: Set<string>;
    appLoadToken: number;
    lastReadyDeviceKey: string;
    query: string;
    loadingDevices: boolean;
    loadingApps: boolean;
    loadingIcons: boolean;
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
    folders: Record<string, Folder>;
    currentFolderId: string | null;
    focusedAppIndex: number | null;
    launchingPackage: string;
    launchMessages: Map<string, { kind: "info" | "error"; text: string }>;
    contextMenu: { x: number; y: number; pkg: string } | null;
    notificationCounts: Record<string, number>;
    createFolderPkg: string;
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
        appLoadToken: 0,
        lastReadyDeviceKey: "",
        query: "",
        loadingDevices: true,
        loadingApps: false,
        loadingIcons: false,
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
    };
}

export const state = createState();

export function resetState(): void {
    Object.assign(state, createState());
}
