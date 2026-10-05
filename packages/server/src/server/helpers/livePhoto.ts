import fs from "fs";
import path from "path";
import { isEmpty } from "@server/helpers/utils";
import { FileSystem } from "@server/fileSystem";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { Server } from "@server";

const LIVE_PHOTO_EXTS = new Set(["png", "jpeg", "jpg", "heic", "tiff"]);

/** Same-stem `.mov` / `.MOV` beside a still path, if present on disk. */
export const siblingMovPath = (stillPath: string): string | null => {
    if (isEmpty(stillPath)) return null;

    const real = FileSystem.getRealPath(stillPath);
    // `.heic.jpeg` double-extension: path.parse only sees `.jpeg`.
    const heicJpeg = real.toLowerCase().endsWith(".heic.jpeg");
    const ext = heicJpeg ? "heic.jpeg" : path.extname(real).slice(1).toLowerCase();
    if (!LIVE_PHOTO_EXTS.has(ext)) return null;

    const stem = heicJpeg ? real.slice(0, -".heic.jpeg".length) : real.slice(0, -path.extname(real).length);
    for (const movExt of [".mov", ".MOV"]) {
        const candidate = `${stem}${movExt}`;
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
};

const auxGuidsForStill = (attachment: Attachment): string[] => {
    const guids = [attachment.guid, attachment.originalGuid].filter(
        (g): g is string => !!g && !g.startsWith("Aux_")
    );
    const aux = new Set<string>();
    for (const guid of guids) {
        aux.add(`Aux_${guid}`);
        if (guid.length > 36) aux.add(`Aux_${guid.substring(guid.length - 36)}`);
    }
    return [...aux];
};

/**
 * Outgoing Live Photos stage as `<attachments>/<uuid>/<stem>.jpg|.mov`.
 * Messages often retargets only the still into chat.db's path, leaving the
 * companion in the staging UUID folder. Find it by transfer / still basename.
 */
export const stagedCompanionPath = (attachment: Attachment): string | null => {
    const stems = [attachment.transferName, attachment.filePath]
        .filter((n): n is string => !isEmpty(n))
        .map(n => path.parse(n).name)
        .filter(Boolean);
    if (stems.length === 0) return null;

    const roots = [FileSystem.messagesAttachmentsDir, FileSystem.attachmentsDir].filter(
        root => !!root && fs.existsSync(root)
    );

    for (const root of roots) {
        let dirs: string[];
        try {
            dirs = fs
                .readdirSync(root, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);
        } catch {
            continue;
        }

        for (const dir of dirs) {
            for (const stem of stems) {
                for (const ext of [".mov", ".MOV"]) {
                    const candidate = path.join(root, dir, `${stem}${ext}`);
                    if (fs.existsSync(candidate)) return candidate;
                }
            }
        }
    }

    return null;
};

const auxTransferPath = async (attachment: Attachment): Promise<string | null> => {
    const repo = Server().iMessageRepo?.db?.getRepository(Attachment);
    if (!repo) return null;

    for (const auxGuid of auxGuidsForStill(attachment)) {
        try {
            const aux = await repo.findOne({ where: { guid: auxGuid } });
            if (!aux?.filePath) continue;
            const auxPath = FileSystem.getRealPath(aux.filePath);
            if (auxPath && fs.existsSync(auxPath)) return auxPath;
        } catch {
            // Fall through
        }
    }
    return null;
};

/**
 * Resolve the companion movie for a Live Photo still.
 *
 * Order: Aux_<stillGuid> chat.db row → sibling of chat.db still path →
 * staged companion under BlueBubbles/Messages attachment dirs (outgoing race).
 */
export const getLivePhotoPath = async (attachment: Attachment): Promise<string | null> => {
    if (!attachment) return null;
    return (
        (await auxTransferPath(attachment)) ??
        siblingMovPath(attachment.filePath) ??
        stagedCompanionPath(attachment)
    );
};
