import path from "path";
import { app } from "electron";
import * as semver from "semver";

/** True when package version is like 1.9.9-canary.N (set by the canary CI build). */
export function isCanaryBuild(): boolean {
    return /canary/i.test(app.getVersion());
}

/**
 * Force Application Support onto the prod folder for canary, otherwise normalize
 * the scoped package name the same way prod always has.
 */
export function patchUserDataPath(): void {
    if (isCanaryBuild()) {
        app.setPath("userData", path.join(app.getPath("appData"), "bluebubbles-server"));
    } else {
        app.setPath("userData", app.getPath("userData").replace("@bluebubbles/server", "bluebubbles-server"));
    }
}

/** Map 1.9.9-canary.2 → 1.9.9+2; otherwise return the raw Electron version. */
export function getDisplayVersion(): string {
    const v = app.getVersion();
    const m = v.match(/^(\d+\.\d+\.\d+)-canary\.(\d+)$/i);
    if (m) return `${m[1]}+${m[2]}`;
    return v;
}

export function getWindowTitle(): string {
    if (isCanaryBuild()) {
        return `BlueBubbles Canary — ${getDisplayVersion()}`;
    }
    return "BlueBubbles Server";
}

export function getTrayVersionLabel(): string {
    if (isCanaryBuild()) {
        return `BlueBubbles Canary v${getDisplayVersion()}`;
    }
    return `BlueBubbles Server v${app.getVersion()}`;
}

export function parseCanaryVersion(version: string): { base: string; n: number } | null {
    const m = version.replace(/^v/i, "").match(/^(\d+\.\d+\.\d+)-canary\.(\d+)$/i);
    if (!m) return null;
    return { base: m[1], n: Number(m[2]) };
}

/** Whether candidate (tag or version string) is a newer canary than current. */
export function isNewerCanary(current: string, candidate: string): boolean {
    const a = parseCanaryVersion(current);
    const b = parseCanaryVersion(candidate);
    if (!a || !b) return false;
    const baseCmp = semver.compare(a.base, b.base);
    if (baseCmp !== 0) return baseCmp < 0;
    return b.n > a.n;
}
