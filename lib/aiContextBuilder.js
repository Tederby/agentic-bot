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
import setting from "../setting.js";
import { getParticipantsPromptSummary } from "./mentionHelper.js";

/**
 * Retrieve persona from persona.txt if present.
 * @returns {string|null}
 */
export function getFilePersona() {
    try {
        const filePath = path.resolve(process.cwd(), "persona.txt");
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8").trim();
            if (content.length > 0) return content;
        }
    } catch {
        // ignore read error
    }
    return null;
}

/**
 * Safely download image from trigger message or its quoted message for Multimodal Vision.
 *
 * @param {object} triggerMessage
 * @returns {Promise<string|null>} Absolute file path to saved image, or null if none
 */
async function extractAndDownloadTriggerImage(triggerMessage) {
    if (!triggerMessage) return null;

    try {
        const tempDir = path.resolve(setting.tempDir || "./temp");
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // 1. Direct image in trigger message
        const isDirectImage = triggerMessage.type === "imageMessage" ||
            triggerMessage.type === "image" ||
            triggerMessage.mtype === "imageMessage" ||
            !!triggerMessage.message?.imageMessage;

        if (isDirectImage && typeof triggerMessage.download === "function") {
            const filePath = path.join(tempDir, `vision_trigger_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
            await triggerMessage.download(filePath);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100) {
                return filePath;
            }
        }

        // 2. Quoted image in trigger message
        const quoted = triggerMessage.quoted;
        if (quoted) {
            const isQuotedImage = quoted.mtype === "imageMessage" ||
                quoted.mtype === "image" ||
                quoted.type === "imageMessage" ||
                quoted.type === "image" ||
                !!quoted.message?.imageMessage;

            if (isQuotedImage && typeof quoted.download === "function") {
                const filePath = path.join(tempDir, `vision_quoted_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
                await quoted.download(filePath);
                if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100) {
                    return filePath;
                }
            }
        }
    } catch (err) {
        console.error("[VISION] Failed to download trigger image:", err.message);
    }
    return null;
}

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
        const rawCap = (row.media_caption || "").replace(/\u200B/g, "").trim();
        const cap = rawCap ? `: "${rawCap}"` : "";
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
    const cleanText = (row.text || "").replace(/\u200B/g, "").trim();
    return cleanText || "[Pesan kosong]";
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
    groupMetadata = null,
}) {
    // 1. Fetch chat settings, global config, and persona.txt
    const chatSettings = getAiChatSettings(chatJid);
    const customChatPersona = chatSettings?.custom_persona?.trim() || null;
    const globalDbPersona = getAiGlobalConfig("default_persona", null)?.trim() || null;
    const filePersona = getFilePersona();

    const rawPersona = customChatPersona || globalDbPersona || filePersona || 
        `Kamu adalah {ownerName}, pemilik akun WhatsApp ini. Kamu sedang membalas obrolan di WhatsApp. Bersikaplah santai, kasual, singkat, padat, dan gunakan gaya bahasa obrolan chat Indonesia sehari-hari. Jangan pernah memperkenalkan diri sebagai AI atau asisten virtual, dan hindari salam formal kaku.`;

    const activePersona = rawPersona.replace(/{ownerName}/g, ownerName);

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
                const qSender = row.is_from_me 
                    ? (row.is_ai ? `${ownerName} (AI Userbot)` : `${ownerName} (Owner Langsung)`)
                    : (row.sender_name || "Lawan Bicara");
                const qContent = serializeMessageContent(row);
                outOfWindowRefs.push(`${tag} | ${qTime} | ${qSender}: ${qContent}`);
            });
        } else if (triggerMessage?.quoted) {
            // Step 4b: Fallback in-memory from WhatsApp protocol payload
            const q = triggerMessage.quoted;
            const isMe = q.key?.fromMe;
            let qSender = "Lawan Bicara";
            if (isMe) {
                const qText = q.text || q.message?.conversation || q.message?.extendedTextMessage?.text || "";
                const isAi = typeof qText === "string" && qText.includes("\u200B");
                qSender = isAi ? `${ownerName} (AI Userbot)` : `${ownerName} (Owner Langsung)`;
            } else if (q.sender) {
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
        const sender = m.is_from_me 
            ? (m.is_ai ? `${ownerName} (AI Userbot)` : `${ownerName} (Owner Langsung)`)
            : (m.sender_name || "Pengguna");
        
        let replyTag = "";
        if (m.quoted_id) {
            if (idToIdx.has(m.quoted_id)) {
                replyTag = ` [Reply #${idToIdx.get(m.quoted_id)}]`;
            } else if (m.quoted_id === triggerQuotedId && outOfWindowRefs.length > 0) {
                replyTag = ` [Reply #Ref]`;
            } else {
                const olderQuoted = getChatMessageById(m.quoted_id);
                if (olderQuoted) {
                    const olderSender = olderQuoted.is_from_me 
                        ? (olderQuoted.is_ai ? "Kamu (AI)" : "Kamu (Owner Langsung)")
                        : (olderQuoted.sender_name || "Pengguna");
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
    const participantsBlock = isGroup
        ? getParticipantsPromptSummary({ chatJid, groupMetadata, triggerMessage, ownerName })
        : "";

    // Multimodal Vision: Download trigger image if present
    const triggerMediaFile = await extractAndDownloadTriggerImage(triggerMessage);
    let visionBlock = "";
    if (triggerMediaFile) {
        visionBlock = 
`[LAMPIRAN GAMBAR PADA PESAN PEMICU]
Lawan bicara mengirim/mengutip sebuah gambar bersama pesannya.
File gambar disimpan sementara di: "${triggerMediaFile}"
Kamu HARUS menggunakan tool \`read_file\` dengan path file di atas untuk memeriksa dan menganalisis gambar tersebut secara visual (multimodal vision). Berikan tanggapan atau analisis yang relevan dan nyambung terhadap gambar tersebut.

`;
    }

    const prompt = 
`[SISTEM // PERSONA]
${activePersona}

[KONTEKS PERCAKAPAN]
Platform     : WhatsApp
Tipe Chat    : ${chatTypeLabel}
Waktu Sistem : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB

[PANDUAN IDENTITAS RIWAYAT PENGIRIM]
- "${ownerName} (Owner Langsung)": Pesan yang diketik manual oleh pemilik asli via HP/Web. Jadikan pernyataan ini fakta utama dan jangan pernah membantah perkataan langsung dari pemilik akun.
- "${ownerName} (AI Userbot)": Pesan otomatis yang sebelumnya kamu (AI) kirimkan.

${participantsBlock}${outOfWindowBlock}${visionBlock}[RIWAYAT 15 OBROLAN TERAKHIR]
${historyLines.length > 0 ? historyLines.join("\n") : "(Belum ada riwayat sebelumnya)"}

[PESAN TERAKHIR YANG MEMICU KAMU UNTUK MEMBALAS]
Pengirim : ${triggerSenderName}
Pesan    : "${effectiveTriggerText}"

[KEMAMPUAN PENCARIAN WEB / GOOGLE]
Kamu memiliki akses internet dan tool pencarian web (\`search_web\`).
Jika lawan bicara menanyakan informasi real-time, berita terkini, jadwal, harga, cuaca, rekomendasi tempat/produk, atau fakta yang memerlukan data terbaru di internet, kamu BISA dan DISARANKAN menggunakan tool \`search_web\` untuk mencari informasi yang valid sebelum membalas. Tetap kembalikan balasan yang santai dan padat.

[KEMAMPUAN GENERATE GAMBAR]
Jika lawan bicara meminta dibuatkan/dicarikan gambar, foto, ilustrasi, lukisan, atau visual (contoh: "buatkan gambar kucing astronot", "gambarin mobil balap", "generate image of ..."), kamu BISA menghasilkan gambar tersebut dengan menyertakan tag khusus di awal balasanmu:
[GENERATE_IMAGE: deskripsi visual dalam bahasa Inggris yang detail, artistik, dan jelas]
Contoh balasan jika diminta gambar:
[GENERATE_IMAGE: A fluffy orange cat wearing sunglasses on a tropical beach, sunny day, high quality digital art]
Nih fotonya bro, santai dulu di pantai wkwk

PERINGATAN KETAT:
- Sertakan tag [GENERATE_IMAGE: ...] HANYA JIKA lawan bicara secara jelas meminta dibuatkan/diberikan gambar.
- JANGAN PERNAH gunakan tag [GENERATE_IMAGE: ...] untuk obrolan santai, pertanyaan umum, atau percakapan teks biasa.

[TUGAS]
Berikan balasan langsung yang natural dan singkat atas nama ${ownerName}. Hanya kembalikan teks balasan saja tanpa pengantar atau penjelasan tambahan.`;

    return {
        prompt,
        triggerMediaFile: triggerMediaFile || null,
    };
}

