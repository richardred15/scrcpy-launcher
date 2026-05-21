import { describe, it, expect, beforeEach } from "vitest";
import { resetState, state } from "./state";
import {
    iconSeed,
    initials,
    shellEscapeText,
    readyDeviceKey,
    selectedDevice,
    isFavorited,
    filteredApps,
} from "./utils";
import type { Device, AndroidApp } from "./types";

beforeEach(() => resetState());

describe("iconSeed", () => {
    it("returns a gradient string", () => {
        const result = iconSeed("com.example.app");
        expect(result).toMatch(/^linear-gradient\(135deg,/);
        expect(result).toContain("hsl(");
    });

    it("is deterministic for the same input", () => {
        expect(iconSeed("com.example.app")).toBe(iconSeed("com.example.app"));
    });

    it("produces different results for different inputs", () => {
        const a = iconSeed("com.alpha");
        const b = iconSeed("com.beta");
        expect(a).not.toBe(b);
    });

    it("handles empty string", () => {
        const result = iconSeed("");
        expect(result).toMatch(/^linear-gradient/);
    });
});

describe("initials", () => {
    it("returns first two uppercase letters for two words", () => {
        expect(initials("hello world")).toBe("HW");
    });

    it("returns single letter for one word", () => {
        expect(initials("android")).toBe("A");
    });

    it("trims to first two words when more are given", () => {
        expect(initials("foo bar baz")).toBe("FB");
    });

    it("returns ? for empty string", () => {
        expect(initials("")).toBe("?");
    });

    it("handles multiple spaces", () => {
        expect(initials("  hello   world  ")).toBe("HW");
    });

    it("uppercases lowercase initials", () => {
        expect(initials("foo bar")).toBe("FB");
    });

    it("preserves already uppercase letters", () => {
        expect(initials("ABC DEF")).toBe("AD");
    });
});

describe("shellEscapeText", () => {
    it("escapes & to &amp;", () => {
        expect(shellEscapeText("a&b")).toBe("a&amp;b");
    });

    it("escapes < to &lt;", () => {
        expect(shellEscapeText("a<b")).toBe("a&lt;b");
    });

    it("escapes > to &gt;", () => {
        expect(shellEscapeText("a>b")).toBe("a&gt;b");
    });

    it("escapes double quote to &quot;", () => {
        expect(shellEscapeText('a"b')).toBe("a&quot;b");
    });

    it("escapes single quote to &#039;", () => {
        expect(shellEscapeText("a'b")).toBe("a&#039;b");
    });

    it("passes through plain text unchanged", () => {
        expect(shellEscapeText("hello world 123")).toBe("hello world 123");
    });

    it("escapes all special chars in one string", () => {
        expect(shellEscapeText(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#039;");
    });

    it("handles empty string", () => {
        expect(shellEscapeText("")).toBe("");
    });
});

describe("readyDeviceKey", () => {
    it("returns empty string for empty array", () => {
        expect(readyDeviceKey([])).toBe("");
    });

    it("formats a single ready device", () => {
        const devices: Device[] = [
            { serial: "abc", state: "device", model: "Pixel", androidVersion: "14", batteryLevel: 50, batteryCharging: false, wireless: false, stableId: "abc" },
        ];
        expect(readyDeviceKey(devices)).toBe("abc:Pixel:14");
    });

    it("sorts multiple devices and joins with pipe", () => {
        const devices: Device[] = [
            { serial: "z00", state: "device", model: "B", androidVersion: "13", batteryLevel: 50, batteryCharging: false, wireless: false, stableId: "z00" },
            { serial: "a00", state: "device", model: "A", androidVersion: "12", batteryLevel: 50, batteryCharging: false, wireless: false, stableId: "a00" },
        ];
        expect(readyDeviceKey(devices)).toBe("a00:A:12|z00:B:13");
    });

    it("filters out non-device states", () => {
        const devices: Device[] = [
            { serial: "online", state: "device", wireless: false, stableId: "online" },
            { serial: "offline", state: "offline", wireless: false, stableId: "offline" },
            { serial: "unauth", state: "unauthorized", wireless: false, stableId: "unauth" },
        ];
        expect(readyDeviceKey(devices)).toBe("online::");
    });

    it("handles missing model and androidVersion", () => {
        const devices: Device[] = [
            { serial: "abc", state: "device", wireless: false, stableId: "abc" },
        ];
        expect(readyDeviceKey(devices)).toBe("abc::");
    });
});

describe("selectedDevice", () => {
    it("returns the device matching selectedSerial", () => {
        state.devices = [
            { serial: "abc", state: "device", wireless: false, stableId: "abc" },
            { serial: "def", state: "device", wireless: false, stableId: "def" },
        ];
        state.selectedSerial = "def";
        expect(selectedDevice()?.serial).toBe("def");
    });

    it("returns undefined when no match", () => {
        state.devices = [
            { serial: "abc", state: "device", wireless: false, stableId: "abc" },
        ];
        state.selectedSerial = "nonexistent";
        expect(selectedDevice()).toBeUndefined();
    });

    it("returns undefined when devices empty", () => {
        state.selectedSerial = "anything";
        expect(selectedDevice()).toBeUndefined();
    });
});

describe("isFavorited", () => {
    it("returns true when pkg is in favorites folder", () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.test.app"] } };
        expect(isFavorited("com.test.app")).toBe(true);
    });

    it("returns false when pkg is not in favorites", () => {
        state.selectedSerial = "abc";
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.other.app"] } };
        expect(isFavorited("com.test.app")).toBe(false);
    });

    it("returns false when no favorites folder exists", () => {
        state.selectedSerial = "abc";
        expect(isFavorited("com.test.app")).toBe(false);
    });
});

describe("filteredApps", () => {
    const apps: AndroidApp[] = [
        { packageName: "com.alpha", label: "Alpha App" },
        { packageName: "com.beta", label: "Beta App" },
        { packageName: "com.gamma", label: "Gamma App" },
        { packageName: "com.delta", label: "Delta App" },
    ];

    it("excludes all folder apps when no query", () => {
        state.selectedSerial = "abc";
        state.apps = apps;
        state.folders["abc"] = {
            favorites: { id: "favorites", name: "Favorites", apps: ["com.alpha"] },
            games: { id: "games", name: "Games", apps: ["com.beta"] },
        };
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.delta", "com.gamma"]);
    });

    it("shows all apps when query is present", () => {
        state.selectedSerial = "abc";
        state.apps = apps;
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.alpha"] } };
        state.query = "a";
        const result = filteredApps();
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by label", () => {
        state.apps = apps;
        state.query = "beta";
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.beta"]);
    });

    it("filters by packageName", () => {
        state.apps = apps;
        state.query = "com.gamma";
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.gamma"]);
    });

    it("is case-insensitive", () => {
        state.apps = apps;
        state.query = "ALPHA";
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.alpha"]);
    });

    it("sorts favorites first during search", () => {
        state.selectedSerial = "abc";
        state.apps = apps;
        state.folders["abc"] = { favorites: { id: "favorites", name: "Favorites", apps: ["com.gamma"] } };
        state.query = "app";
        const result = filteredApps();
        expect(result[0].packageName).toBe("com.gamma");
    });

    it("returns empty array when no apps match", () => {
        state.apps = apps;
        state.query = "zzzzz";
        expect(filteredApps()).toEqual([]);
    });

    it("handles empty state.apps", () => {
        expect(filteredApps()).toEqual([]);
    });

    it("trims whitespace from query", () => {
        state.apps = apps;
        state.query = "  alpha  ";
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.alpha"]);
    });

    it("sorts non-favorites alphabetically", () => {
        state.apps = [
            { packageName: "com.z", label: "Zeta" },
            { packageName: "com.a", label: "Alpha" },
        ];
        state.query = "a";
        const result = filteredApps();
        expect(result.map(a => a.packageName)).toEqual(["com.a", "com.z"]);
    });
});
