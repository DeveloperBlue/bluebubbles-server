import { isMinBigSur, isMinMonterey } from "@server/env";
import { DylibPlugin } from ".";
import { FileSystem } from "@server/fileSystem";
import { Server } from "@server";
import { isNotEmpty } from "@server/helpers/utils";
import { FindMyInterface } from "@server/api/interfaces/findMyInterface";
import fs from "fs";
import path from "path";

const macVer = isMinMonterey ? "macos11" : isMinBigSur ? "macos11" : "macos10";

export class MessagesDylibPlugin extends DylibPlugin {
    tag = "MessagesDylibPlugin";

    parentApp = "Messages";

    bundleIdentifier = "com.apple.MobileSMS";

    get dylibPath() {
        // Dev-only: inject a helper built from ~/Projects/bluebubbles-helper without
        // overwriting the stock dylib inside BlueBubbles.app.
        const override = process.env.BB_HELPER_DYLIB?.trim();
        if (override && fs.existsSync(override)) {
            return override;
        }
        return path.join(FileSystem.resources, "private-api", macVer, "BlueBubblesHelper.dylib");
    }

    get isEnabled() {
        return Server().repo.getConfig("enable_private_api") as boolean;
    }

    async injectPlugin(_?: () => void): Promise<void> {
        const bundled = path.join(FileSystem.resources, "private-api", macVer, "BlueBubblesHelper.dylib");
        if (this.dylibPath !== bundled) {
            this.log.info(`Using experimental helper dylib: ${this.dylibPath}`);
        } else {
            this.log.info(`Using bundled helper dylib: ${this.dylibPath}`);
        }
        return await super.injectPlugin(async () => {
            // If we've already cached some locations, we don't need to again
            if (Server().findMyCache.getAll().length > 0) return;

            // Only open the FindMy App if the user wants to
            const openFindMy = Server().repo.getConfig("open_findmy_on_startup") as boolean;
            const locations = await FindMyInterface.refreshFriends(openFindMy);
            if (isNotEmpty(locations)) {
                Server().findMyCache.addAll(locations);
            }
        });
    }
}
