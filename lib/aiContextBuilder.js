/**
 * AI Context Builder — Sliding Window & Thread Tagging
 *
 * Formats conversation history into an optimized prompt for LLM/Agent execution:
 *  - Chronological 15-message sliding window
 *  - Thread tagging (#1, #2 [Reply #1])
 *  - Out-of-window quoted message recovery via SQLite lookup
 *  - Zero-download media tags ([Mengirim foto: caption])
 */

import { getRecentChatMessages, getChatMessageById, getAiChatSettings, getAiGlobalConfig } from "./database.js";
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

    // 4. Check for Out-of-window quoted message
    let outOfWindowBlock = "";
    const triggerQuotedId = triggerMessage?.contextInfo?.stanzaId || triggerMessage?.quoted?.key?.id;
    if (triggerQuotedId && !idToIdx.has(triggerQuotedId)) {
        const quotedRow = getChatMessageById(triggerQuotedId);
        if (quotedRow) {
            const qTime = formatTime(quotedRow.timestamp);
            const qSender = quotedRow.is_from_me ? `${ownerName} (Kamu)` : (quotedRow.sender_name || "Lawan Bicara");
            const qContent = serializeMessageContent(quotedRow);
            outOfWindowBlock = `[Pesan Yang Dikutip Berasal Dari Luar Riwayat Terkini]\n#Ref | ${qTime} | ${qSender}: ${qContent}\n\n`;
        }
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
            } else if (m.quoted_id === triggerQuotedId && outOfWindowBlock) {
                replyTag = ` [Reply #Ref]`;
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

