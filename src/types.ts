export type Folder = {
    id: string;
    name: string;
    apps: string[];
};

export type SettingsState = {
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
    wirelessDevices: string[];
    lastWirelessHost: string;
    lastWirelessPort: string;
    folders: Record<string, Record<string, Folder>>;
    deviceNicknames: Record<string, string>;
    ignoredUpdateVersion: string;
};

export type BinaryStatus = {
    path: string;
    found: boolean;
    version?: string;
    help: string;
};

export type ToolStatus = {
    adb: BinaryStatus;
    scrcpy: BinaryStatus;
};

export type Device = {
    serial: string;
    state: string;
    model?: string;
    androidVersion?: string;
    batteryLevel?: number;
    batteryTemperature?: number;
    batteryCharging?: boolean;
    wireless: boolean;
    stableId: string;
};

export type AndroidApp = {
    packageName: string;
    activity?: string;
    label: string;
    iconUrl?: string;
};

export type LaunchResult = {
    usedFlexDisplay: boolean;
    message?: string;
};

export type AppMetaResolvedEvent = {
    packageName: string;
    label: string;
    iconUrl: string | null;
};

export type CachedAppMeta = {
    label: string;
    iconDataUrl: string | null;
    source: string;
    resolvedAt: number;
};

export type AppsLoadedEvent = {
    serial: string;
    apps: AndroidApp[];
};

export type MdnsDiscoveredDevice = {
    serviceName: string;
    serviceType: string;
    host: string;
    port: number;
};
