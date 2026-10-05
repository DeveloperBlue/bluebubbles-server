import { nativeImage } from "electron";
import fs from "fs";
import { getBlurHash, isEmpty, isNotEmpty, resultAwaiter } from "@server/helpers/utils";
import { FileSystem } from "@server/fileSystem";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { Server } from "@server";

export class AttachmentInterface {
    static livePhotoExts = ["png", "jpeg", "jpg", "heic", "tiff"];

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

    static async upload(path: string, name: string): Promise<string> {
        if (!path || !name) throw new Error("No path/name provided!");
        if (!fs.existsSync(path)) throw new Error("File does not exist!");

        // Copy the attachment to a more permanent storage using the papi method.
        // This is so the attachment gets copied to the iMessage directory.
        return FileSystem.copyAttachment(path, name, "private-api");
    }

    /**
     * Resolve the companion movie for a Live Photo still.
     *
     * Prefer the Aux_<stillGuid> attachment (how Messages links iris) over a
     * same-stem .mov next to chat.db's still path — outgoing sends often have
     * the movie only on the Aux transfer until/unless the library settles.
     */
    static async getLivePhotoPath(attachment: Attachment): Promise<string | null> {
        if (!attachment) return null;

        // 1) Aux transfer GUID: Aux_<stillGuid> (and bare-UUID form if prefixed)
        const stillGuids = [attachment.guid, attachment.originalGuid].filter(
            (g): g is string => !!g && !g.startsWith("Aux_")
        );
        const auxGuids = new Set<string>();
        for (const guid of stillGuids) {
            auxGuids.add(`Aux_${guid}`);
            if (guid.length > 36) {
                auxGuids.add(`Aux_${guid.substring(guid.length - 36)}`);
            }
        }

        const repo = Server().iMessageRepo?.db?.getRepository(Attachment);
        if (repo && auxGuids.size > 0) {
            for (const auxGuid of auxGuids) {
                try {
                    const aux = await repo.findOne({ where: { guid: auxGuid } });
                    if (!aux?.filePath) continue;
                    const auxPath = FileSystem.getRealPath(aux.filePath);
                    if (auxPath && fs.existsSync(auxPath)) return auxPath;
                } catch {
                    // Fall through to sibling sniff
                }
            }
        }

        // 2) Fallback: settled library layout (same-stem .mov beside the still)
        const fPath = attachment.filePath;
        if (isEmpty(fPath)) return null;

        let ext = fPath.includes(".heic.jpeg") ? "heic.jpeg" : fPath.split(".").pop() ?? "";
        if (!AttachmentInterface.livePhotoExts.includes(ext.toLowerCase())) return null;

        const escaped = ext.replace(/\./g, "\\.");
        const livePath = isNotEmpty(ext)
            ? fPath.replace(new RegExp(`\\.${escaped}$`), ".mov")
            : `${fPath}.mov`;
        const realPath = FileSystem.getRealPath(livePath);
        if (fs.existsSync(realPath)) return realPath;

        // Messages sometimes stores .MOV
        const upper = FileSystem.getRealPath(
            isNotEmpty(ext) ? fPath.replace(new RegExp(`\\.${escaped}$`), ".MOV") : `${fPath}.MOV`
        );
        return fs.existsSync(upper) ? upper : null;
    }

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
