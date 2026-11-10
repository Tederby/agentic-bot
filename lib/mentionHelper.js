/**
 * Smart Mention Helper — WhatsApp Mention & Tag Resolver
 *
 * Resolves @Name or @Phone in AI responses to valid WhatsApp mentions:
 *  - Maps participant names/pushnames to canonical JIDs & phone numbers
 *  - Automatically converts @Name to @<phoneNumber> in message text
 *  - Injects target JIDs into the Baileys `mentions: [...]` array
 *  - Generates participant context for the AI prompt
 */

import db from "./db.js";
import { resolveUserId } from "./database.js";
import { jidNormalizedUser } from "baileys";

// Cached statement for fetching recent group participants
const stmts = {
    getRecentGroupSenders: db.prepare(`
        SELECT DISTINCT sender_jid, sender_name 
        FROM chat_messages 
        WHERE chat_jid = ? AND sender_name IS NOT NULL AND is_from_me = 0
        ORDER BY timestamp DESC 
        LIMIT 25
    `),
};

/**
 * Clean a pushname into an alphanumeric tag-friendly slug.
 * @param {string} name
 * @returns {string}
 */
function cleanTagName(name) {
    if (!name) return "";
    return name
        .replace(/[\u{1F600}-\u{1F6FF}|[\u{2600}-\u{26FF}]/gu, "") // strip common emojis
        .replace(/[^\w\s\.-]/g, "") // keep alphanumeric, spaces, dots, dashes
        .trim();
}

/**
 * Fetch known participants for a chat.
 *
 * @param {object} params
 * @param {string} params.chatJid
 * @param {object} [params.groupMetadata]
 * @param {object} [params.triggerMessage]
 * @returns {Array<{ jid: string, pn: string, name: string, cleanName: string, firstName: string }>}
 */
export function getKnownParticipants({ chatJid, groupMetadata = null, triggerMessage = null }) {
    if (!chatJid || !chatJid.endsWith("@g.us")) return [];

    const map = new Map(); // pn -> participant info

    function addParticipant(jid, name) {
        if (!jid) return;
        const canonical = resolveUserId(jidNormalizedUser(jid));
        const pn = canonical.split("@")[0].replace(/[^0-9]/g, "");
        if (!pn || pn.length < 6) return;

        const displayName = (name || "").trim();
        const clean = cleanTagName(displayName);
        const firstName = clean ? clean.split(/\s+/)[0] : "";

        if (!map.has(pn) || (!map.get(pn).name && displayName)) {
            map.set(pn, {
                jid: canonical,
                rawJid: jid,
                pn,
                name: displayName || pn,
                cleanName: clean || pn,
                firstName: firstName || pn,
            });
        }
    }

    // 1. From trigger message (most recent and reliable)
    if (triggerMessage?.sender) {
        addParticipant(triggerMessage.sender, triggerMessage.pushName);
    }

    // 2. From recent chat messages in SQLite
    try {
        const rows = stmts.getRecentGroupSenders.all(chatJid);
        for (const row of rows) {
            addParticipant(row.sender_jid, row.sender_name);
        }
    } catch (e) {
        // ignore db error
    }

    // 3. From group metadata participants (Baileys)
    if (groupMetadata?.participants) {
        for (const p of groupMetadata.participants) {
            addParticipant(p.id, null);
        }
    }

    return Array.from(map.values());
}

/**
 * Build a lookup map from name variations to participant info.
 *
 * @param {object} params
 * @returns {Map<string, object>}
 */
export function buildParticipantLookup(params) {
    const participants = getKnownParticipants(params);
    const lookup = new Map();

    for (const p of participants) {
        // Direct phone number
        lookup.set(p.pn, p);

        // Full display name (lowercase)
        if (p.name) {
            lookup.set(p.name.toLowerCase(), p);
        }

        // Clean name (lowercase)
        if (p.cleanName) {
            lookup.set(p.cleanName.toLowerCase(), p);
        }

        // First name (lowercase, if not conflicting)
        if (p.firstName && p.firstName.length >= 3) {
            const fLower = p.firstName.toLowerCase();
            if (!lookup.has(fLower)) {
                lookup.set(fLower, p);
            }
        }
    }

    return { participants, lookup };
}

/**
 * Resolve Smart Mentions in AI response text.
 * Converts `@Name` to `@<phoneNumber>` and collects all target JIDs.
 *
 * @param {string} text - Raw AI reply text
 * @param {object} params - Context params
 * @param {string} params.chatJid
 * @param {object} [params.groupMetadata]
 * @param {object} [params.triggerMessage]
 * @returns {{ text: string, mentions: string[] }}
 */
export function resolveSmartMentions(text, params) {
    if (!text || typeof text !== "string") {
        return { text: text || "", mentions: [] };
    }

    const mentions = new Set();

    // 1. First extract direct phone number tags: @628123456789
    text = text.replace(/(^|[^a-zA-Z0-9])@(\d{8,16})\b/g, (match, prefix, num) => {
        const jid = `${num}@s.whatsapp.net`;
        mentions.add(jid);
        return `${prefix}@${num}`;
    });

    // If not a group, we only support direct @phone tags
    if (!params.chatJid || !params.chatJid.endsWith("@g.us")) {
        return { text, mentions: Array.from(mentions) };
    }

    const { participants, lookup } = buildParticipantLookup(params);
    if (participants.length === 0) {
        return { text, mentions: Array.from(mentions) };
    }

    // Sort participants by longest name first to prevent partial prefix replacements
    // e.g. "Afif Fatin" before "Afif"
    const sortedCandidates = [];
    for (const p of participants) {
        if (p.cleanName && p.cleanName.length >= 2) {
            sortedCandidates.push({ token: p.cleanName, target: p });
        }
        if (p.firstName && p.firstName.length >= 3 && p.firstName !== p.cleanName) {
            sortedCandidates.push({ token: p.firstName, target: p });
        }
    }
    sortedCandidates.sort((a, b) => b.token.length - a.token.length);

    // Replace @CandidateName with @<phoneNumber>
    for (const cand of sortedCandidates) {
        const escaped = cand.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Match @Name with word boundary or non-word character
        const regex = new RegExp(`(^|[^a-zA-Z0-9])@${escaped}(?=[^a-zA-Z0-9]|$)`, "gi");
        if (regex.test(text)) {
            text = text.replace(regex, (match, prefix) => {
                const targetJid = `${cand.target.pn}@s.whatsapp.net`;
                mentions.add(targetJid);
                if (cand.target.rawJid && cand.target.rawJid.endsWith("@lid")) {
                    mentions.add(cand.target.rawJid);
                }
                return `${prefix}@${cand.target.pn}`;
            });
        }
    }

    return {
        text,
        mentions: Array.from(mentions),
    };
}

/**
 * Generate a concise participants list to inform the AI prompt.
 *
 * @param {object} params
 * @returns {string}
 */
export function getParticipantsPromptSummary(params) {
    if (!params.chatJid || !params.chatJid.endsWith("@g.us")) return "";

    const { participants } = buildParticipantLookup(params);
    if (participants.length === 0) return "";

    const lines = participants
        .filter(p => p.name && p.name !== "You" && p.name !== "Owner")
        .slice(0, 10)
        .map(p => {
            const tagAlias = p.firstName && p.firstName.length >= 3 ? p.firstName : p.cleanName;
            return `- ${p.name} (bisa di-tag: @${tagAlias})`;
        });

    if (lines.length === 0) return "";

    return (
`[PARTISIPAN DALAM GRUP INI]
Berikut anggota yang aktif dalam percakapan:
${lines.join("\n")}

[PANDUAN MENTION / TAG ANGGOTA]
- Jika ingin memanggil, menyapa, atau men-tag seseorang di grup, sebut mereka dengan format \`@Nama\` (contoh: \`@${participants[0]?.firstName || "Budi"}\`).
- Sistem akan otomatis mengubah tag tersebut menjadi tag WhatsApp resmi yang aktif dan berwarna biru.
- Jangan gunakan tag jika tidak perlu memanggil orang secara spesifik.

`
    );
}
