import { nativeImage } from "electron";
import fs from "fs";
import { getBlurHash, resultAwaiter } from "@server/helpers/utils";
import { getLivePhotoPath } from "@server/helpers/livePhoto";
import { FileSystem } from "@server/fileSystem";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { Server } from "@server";

export class AttachmentInterface {
    static async getBlurhash({
        filePath,
        width = null,
        height = null,
        componentX = 3,
        componentY = 3,
        quality = "good"
    }: any): Promise<string> {
        const bh = await getBlurHash({
            image: nativeImage.createFromPath(filePath),
            width,
            height,
            quality,
            componentX,
            componentY
        });
        return bh;
    }

    static async upload(filePath: string, name: string): Promise<string> {
        if (!filePath || !name) throw new Error("No path/name provided!");
        if (!fs.existsSync(filePath)) throw new Error("File does not exist!");

        // Copy the attachment to a more permanent storage using the papi method.
        // This is so the attachment gets copied to the iMessage directory.
        return FileSystem.copyAttachment(filePath, name, "private-api");
    }

    /** @see {@link getLivePhotoPath} */
    static getLivePhotoPath = getLivePhotoPath;

    static async forceDownload(attachment: Attachment): Promise<Attachment> {
        await Server().privateApi.attachment.downloadPurged(attachment.guid);

        attachment = await resultAwaiter({
            maxWaitMs: 1000 * 60 * 10,
            initialWaitMs: 1000 * 5,
            waitMultiplier: 1,
            getData: (_: any) => {
                return Server().iMessageRepo.getAttachment(attachment.guid);
            },
            dataLoopCondition: (data: Attachment) => {
                return !data || data.transferState !== 5;
            }
        });

        if (!attachment || attachment.transferState !== 5) {
            throw new Error(`Failed to download attachment! Transfer State: ${attachment?.transferState}`);
        }

        return attachment;
    }
}
