// Canary overlay for electron-builder. CI sets CANARY_BASE / CANARY_N and uses --publish never.
// Build unsigned: CSC_IDENTITY_AUTO_DISCOVERY=false (no Apple Developer ID on the fork).
const base = process.env.CANARY_BASE || "0.0.0";
const n = process.env.CANARY_N || "0";
const prod = require("./electron-builder-config.js");
const { publish, ...macRest } = prod.mac;

module.exports = {
    ...prod,
    productName: "BlueBubbles Canary",
    appId: "com.BlueBubbles.BlueBubbles-Server.Canary",
    // Always include arch; the workflow renames *-x64.dmg to drop the suffix.
    artifactName: `bluebubbles-${base}-canary.${n}-\${arch}.\${ext}`,
    mac: {
        ...macRest,
        // Unsigned personal canary — no Apple Developer ID on this fork.
        identity: null
    }
};
