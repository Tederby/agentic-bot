/**
 * AI Context Builder — Sliding Window & Thread Tagging
 *
 * Formats conversation history into an optimized prompt for LLM/Agent execution:
 *  - Chronological 15-message sliding window
 *  - Thread tagging (#1, #2 [Reply #1])
 *  - Out-of-window quoted message recovery via SQLite lookup
 *  - Zero-download media tags ([Mengirim foto: caption])
 */

import { getRecentChatMessages, getChatMessageById, getAiChatSettings, getAiGlobalConfig, getUser, resolveUserId } from "./database.js";
import path from "path";
import fs from "fs";

/**
 * Format a Unix timestamp to HH:mm.
 * @param {number} sec
 * @returns {string}
 */
function formatTime(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Serialize a message row into declarative text for the prompt.
 * @param {object} row
 * @returns {string}
 */
function serializeMessageContent(row) {
    if (row.media_type) {
        const cap = row.media_caption ? `: "${row.media_caption}"` : "";
        switch (row.media_type) {
            case "image":
                return `[Mengirim foto${cap}]`;
            case "video":
                return `[Mengirim video${cap}]`;
            case "sticker":
                return `[Mengirim stiker]`;
            case "audio":
                return `[Mengirim pesan suara]`;
            case "document":
                return `[Mengirim dokumen${cap}]`;
            default:
                return `[Mengirim media: ${row.media_type}${cap}]`;
        }
    }
    return row.text || "[Pesan kosong]";
}

/**
 * Extract declarative text or media summary from an in-memory quoted object.
 * @param {object} quoted
 * @returns {string|null}
 */
function extractQuotedContentFromMessage(quoted) {
    if (!quoted) return null;
    if (quoted.text) return quoted.text;
    if (quoted.message) {
        const mtype = quoted.mtype || Object.keys(quoted.message)[0];
        const inner = quoted.message[mtype];
        const caption = inner?.caption || inner?.description || "";
        const cap = caption ? `: "${caption}"` : "";
        switch (mtype) {
            case "imageMessage":
            case "image":
                return `[Mengirim foto${cap}]`;
            case "videoMessage":
            case "video":
                return `[Mengirim video${cap}]`;
            case "stickerMessage":
            case "sticker":
                return `[Mengirim stiker]`;
            case "audioMessage":
            case "audio":
                return `[Mengirim pesan suara]`;
            case "documentMessage":
            case "document":
                return `[Mengirim dokumen${cap}]`;
            default:
                return caption || `[Mengirim media: ${mtype}]`;
        }
    }
    return null;
}

/**
 * Build a structured context prompt for the AI engine.
 *
 * @param {object} params
 * @param {string} params.chatJid - WhatsApp chat JID (DM or Group)
 * @param {string} params.chatName - Group name or DM sender name
 * @param {boolean} params.isGroup - Whether chat is a group
 * @param {string} params.ownerName - Account owner display name
 * @param {object} params.triggerMessage - The triggering WAMessage
 * @param {string} [params.triggerText] - Accumulated trigger text
 * @returns {Promise<{ prompt: string, triggerMediaFile: string|null }>}
 */
export async function buildAiPrompt({
    chatJid,
    chatName = "",
    isGroup = false,
    ownerName = "Pemilik Akun",
    triggerMessage,
    triggerText = "",
}) {
    // 1. Fetch chat settings & custom persona if any
    const chatSettings = getAiChatSettings(chatJid);
    const globalPersona = getAiGlobalConfig("default_persona", null);
    const activePersona = chatSettings?.custom_persona || globalPersona || 
        `Kamu adalah ${ownerName}, pemilik akun WhatsApp ini. Kamu sedang membalas obrolan di WhatsApp. Bersikaplah santai, kasual, singkat, padat, dan gunakan gaya bahasa obrolan chat Indonesia sehari-hari. Jangan pernah memperkenalkan diri sebagai AI atau asisten virtual, dan hindari salam formal kaku.`;

    // 2. Retrieve recent 15 messages from SQLite
    const recent = getRecentChatMessages(chatJid, 15);

    // 3. Map stanzaId -> local index (#1, #2, ...)
    const idToIdx = new Map();
    recent.forEach((m, idx) => {
        idToIdx.set(m.id, idx + 1);
    });

    // 4. Check for Out-of-window quoted message & Ancestor Chaining
    const outOfWindowRefs = [];
    const triggerQuotedId = triggerMessage?.contextInfo?.stanzaId || triggerMessage?.quoted?.key?.id;

    if (triggerQuotedId && !idToIdx.has(triggerQuotedId)) {
        // Step 4a: Look up in SQLite first
        const quotedRow = getChatMessageById(triggerQuotedId);
        if (quotedRow) {
            // Ancestor chaining (traverse parents up to 2 hops if present)
            const chain = [quotedRow];
            let curr = quotedRow;
            let depth = 0;
            while (curr.quoted_id && depth < 2) {
                const parent = getChatMessageById(curr.quoted_id);
                if (parent && !idToIdx.has(parent.id)) {
                    chain.unshift(parent);
                    curr = parent;
                    depth++;
                } else {
                    break;
                }
            }

            chain.forEach((row, i) => {
                const tag = chain.length > 1 ? `#Ref-${chain.length - i}` : `#Ref`;
                const qTime = formatTime(row.timestamp);
                const qSender = row.is_from_me ? `${ownerName} (Kamu)` : (row.sender_name || "Lawan Bicara");
                const qContent = serializeMessageContent(row);
                outOfWindowRefs.push(`${tag} | ${qTime} | ${qSender}: ${qContent}`);
            });
        } else if (triggerMessage?.quoted) {
            // Step 4b: Fallback in-memory from WhatsApp protocol payload
            const q = triggerMessage.quoted;
            const isMe = q.key?.fromMe;
            let qSender = isMe ? `${ownerName} (Kamu)` : "Lawan Bicara";
            if (!isMe && q.sender) {
                const canonicalSender = resolveUserId(q.sender);
                const userObj = getUser(canonicalSender);
                qSender = userObj?.name || (canonicalSender.split("@")[0]);
            }
            const qContent = extractQuotedContentFromMessage(q) || "[Konten Kutipan Lampau]";
            outOfWindowRefs.push(`#Ref | [Sesi Lampau] | ${qSender}: ${qContent}`);
        }
    }

    let outOfWindowBlock = "";
    if (outOfWindowRefs.length > 0) {
        outOfWindowBlock = `[Pesan Yang Dikutip Berasal Dari Luar Riwayat Terkini]\n${outOfWindowRefs.join("\n")}\n\n`;
    }

    // 5. Build chronological chat history lines
    const historyLines = recent.map((m, idx) => {
        const num = idx + 1;
        const timeStr = formatTime(m.timestamp);
        const sender = m.is_from_me ? `${ownerName} (Kamu)` : (m.sender_name || "Pengguna");
        
        let replyTag = "";
        if (m.quoted_id) {
            if (idToIdx.has(m.quoted_id)) {
                replyTag = ` [Reply #${idToIdx.get(m.quoted_id)}]`;
            } else if (m.quoted_id === triggerQuotedId && outOfWindowRefs.length > 0) {
                replyTag = ` [Reply #Ref]`;
            } else {
                const olderQuoted = getChatMessageById(m.quoted_id);
                if (olderQuoted) {
                    const olderSender = olderQuoted.is_from_me ? "Kamu" : (olderQuoted.sender_name || "Pengguna");
                    replyTag = ` [Reply: "${olderSender}"]`;
                }
            }
        }

        const content = serializeMessageContent(m);
        return `#${num} | ${timeStr} | ${sender}${replyTag}: ${content}`;
    });

    const triggerSenderName = triggerMessage?.pushName || "Lawan Bicara";
    const effectiveTriggerText = triggerText || triggerMessage?.text || serializeMessageContent({
        media_type: triggerMessage?.type,
        media_caption: triggerMessage?.message?.[triggerMessage?.type]?.caption,
        text: triggerMessage?.text,
    });

    const chatTypeLabel = isGroup ? `Grup ("${chatName}")` : `Chat Pribadi (DM)`;

    const prompt = 
`[SISTEM // PERSONA]
${activePersona}

[KONTEKS PERCAKAPAN]
Platform     : WhatsApp
Tipe Chat    : ${chatTypeLabel}
Waktu Sistem : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB

${outOfWindowBlock}[RIWAYAT 15 OBROLAN TERAKHIR]
${historyLines.length > 0 ? historyLines.join("\n") : "(Belum ada riwayat sebelumnya)"}

[PESAN TERAKHIR YANG MEMICU KAMU UNTUK MEMBALAS]
Pengirim : ${triggerSenderName}
Pesan    : "${effectiveTriggerText}"

[TUGAS]
Berikan balasan langsung yang natural dan singkat atas nama ${ownerName}. Hanya kembalikan teks balasan saja tanpa pengantar atau penjelasan tambahan.`;

    return {
        prompt,
        triggerMediaFile: null,
    };
}

