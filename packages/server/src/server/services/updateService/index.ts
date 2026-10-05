import { app, BrowserWindow, dialog, MessageBoxOptions, Notification } from "electron";
import * as semver from "semver";
import { Server } from "@server";
import { SERVER_UPDATE } from "@server/events";
import { ScheduledService } from "@server/lib/ScheduledService";
import { Loggable } from "@server/lib/logging/Loggable";
import { getDisplayVersion, isCanaryBuild, isNewerCanary } from "@server/helpers/canary";
import axios, { AxiosResponse } from "axios";

export class UpdateService extends Loggable {
    tag = "UpdateService";

    window: BrowserWindow;

    timer: ScheduledService;

    currentVersion: string;

    isOpen: boolean;

    hasUpdate = false;

    updateInfo: any;

    constructor(window: BrowserWindow) {
        super();

        // This won't work in dev-mode because it checks Electron's Version
        this.currentVersion = app.getVersion();
        this.isOpen = false;
        this.window = window;

        // Correct current version if needed (non-canary only; canary needs the -canary.N suffix)
        if (!isCanaryBuild() && this.currentVersion.split(".").length > 3) {
            this.currentVersion = semver.coerce(this.currentVersion).format();
        }
    }

    start() {
        if (this.timer) return;
        this.timer = new ScheduledService(async () => {
            if (this.hasUpdate) return;

            await this?.checkForUpdate();
        }, 1000 * 60 * 60 * 12); // Default 12 hours
    }

    stop() {
        if (this.timer) {
            this.timer.stop();
            this.timer = null;
        }
    }

    async checkForUpdate({ showNoUpdateDialog = false, showUpdateDialog = true } = {}): Promise<boolean> {
        const canary = isCanaryBuild();
        const repo = canary ? "DeveloperBlue/bluebubbles-server" : "BlueBubblesApp/bluebubbles-server";
        let releasesRes: AxiosResponse<any, any>;

        try {
            releasesRes = await axios.get(`https://api.github.com/repos/${repo}/releases`, {
                headers: {
                    Accept: "application/vnd.github.v3+json"
                }
            });
        } catch (ex: any) {
            this.log.error(`Failed to fetch release information from GitHub! Error: ${ex?.message ?? String(ex)}`);
            return false;
        }

        const releases = (releasesRes.data as any[]).filter(x => {
            if (x.draft) return false;
            const hasDmg = x.assets.some(
                (y: any) =>
                    y.name.endsWith(".dmg") &&
                    (canary
                        ? y.name.startsWith("bluebubbles-") && y.name.includes("-canary.")
                        : y.name.startsWith("BlueBubbles-"))
            );
            if (!hasDmg) return false;
            if (canary) {
                return x.prerelease && /v\d+\.\d+\.\d+-canary\.\d+/i.test(x.tag_name);
            }
            return !x.prerelease && x.tag_name.match(/v\d+\.\d+\.\d+/);
        });
        if (!releases || releases.length === 0) return false;

        // Get the version of the latest release
        const latest = releases[0];
        const latestVersion = latest.tag_name.replace(/^v/i, "");

        if (canary) {
            this.hasUpdate = isNewerCanary(this.currentVersion, latestVersion);
        } else {
            const semverVersion = semver.coerce(latestVersion).format();
            this.hasUpdate = semver.lt(this.currentVersion, semverVersion);
        }
        this.updateInfo = latest;

        if (this.hasUpdate) {
            Server().emitMessage(SERVER_UPDATE, latestVersion);
            Server().emitToUI("update-available", latestVersion);
            Server().emit("update-available", latestVersion);

            if (showUpdateDialog) {
                const notification = {
                    title: canary ? "BlueBubbles Canary Update Available!" : "BlueBubbles Update Available!",
                    body: canary
                        ? `BlueBubbles Canary ${latestVersion} is now available to be installed!`
                        : `BlueBubbles macOS Server v${latestVersion} is now available to be installed!`
                };
                new Notification(notification).show();
            }
        }

        if (!this.hasUpdate && showNoUpdateDialog) {
            const dialogOpts: MessageBoxOptions = {
                type: "info",
                title: canary ? "BlueBubbles Canary Update" : "BlueBubbles Update",
                message: "You have the latest version installed!",
                detail: canary
                    ? `You are running the latest BlueBubbles Canary! ${getDisplayVersion()}`
                    : `You are running the latest version of BlueBubbles! v${this.currentVersion}`
            };

            dialog.showMessageBox(this.window, dialogOpts);
        }

        return this.hasUpdate;
    }
}
