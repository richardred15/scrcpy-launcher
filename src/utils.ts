import { state } from "./state";
import type { Device, AndroidApp } from "./types";

export function iconSeed(packageName: string): string {
    let hash = 0;
    for (const char of packageName)
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    return `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 70% 38%))`;
}

export function initials(label: string): string {
    return (
        label
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || "?"
    );
}

export function selectedDevice(): Device | undefined {
    return state.devices.find(
        (device) => device.serial === state.selectedSerial,
    );
}

export function isFavorited(pkg: string): boolean {
    return state.folders["favorites"]?.apps.includes(pkg) ?? false;
}

export function filteredApps(): AndroidApp[] {
    const query = state.query.trim().toLowerCase();

    const allFolderApps = new Set<string>();
    Object.values(state.folders).forEach(f => {
        f.apps.forEach(pkg => allFolderApps.add(pkg));
    });

    let apps = query ? state.apps : state.apps.filter(app => !allFolderApps.has(app.packageName));

    if (query) {
        apps = apps.filter((item) => {
            return (
                item.label.toLowerCase().includes(query) ||
                item.packageName.toLowerCase().includes(query)
            );
        });
    }

    return [...apps].sort((a, b) => {
        if (query) {
            const aFav = isFavorited(a.packageName);
            const bFav = isFavorited(b.packageName);
            if (aFav !== bFav) {
                return aFav ? -1 : 1;
            }
        }
        return a.label.localeCompare(b.label);
    });
}

export function shellEscapeText(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        const map: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;",
        };
        return map[char];
    });
}

export function readyDeviceKey(devices: Device[]): string {
    return devices
        .filter((device) => device.state === "device")
        .map(
            (device) =>
                `${device.serial}:${device.model || ""}:${device.androidVersion || ""}`,
        )
        .sort()
        .join("|");
}
