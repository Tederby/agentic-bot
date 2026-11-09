/**
 * Message Logger — Ingestion Pipeline for Chat History
 *
 * Saves incoming and outgoing (fromMe) WhatsApp messages to SQLite
 * for sliding-window context retrieval and quoted-thread reconstruction.
 */

import { saveChatMessage, resolveUserId } from "./database.js";
import { jidNormalizedUser } from "baileys";

/**
 * Extract clean metadata and save message to SQLite chat_messages table.
 *
 * @param {object} message - Extended WAMessage from Messages()
 * @returns {void}
 */
export function logMessage(message) {
    if (!message || !message.key || !message.chat) return;

    try {
        const id = message.id || message.key.id;
        if (!id) return;

        const chat_jid = message.chat;
        const is_from_me = message.key.fromMe ? 1 : 0;
        
        let sender_jid = message.sender || "";
        if (sender_jid) {
            sender_jid = resolveUserId(jidNormalizedUser(sender_jid));
        }

        const sender_name = message.pushName || (is_from_me ? "You" : null);
        const text = message.text || "";

        // Extract media type and caption if present
        let media_type = null;
        let media_caption = null;

        if (message.type) {
            const rawType = message.type;
            if (rawType === "imageMessage") media_type = "image";
            else if (rawType === "videoMessage") media_type = "video";
            else if (rawType === "stickerMessage") media_type = "sticker";
            else if (rawType === "audioMessage") media_type = "audio";
            else if (rawType === "documentMessage") media_type = "document";
            else if (rawType !== "conversation" && rawType !== "extendedTextMessage") {
                media_type = rawType;
            }
        }

        if (media_type && message.message) {
            const inner = message.message[message.type];
            media_caption = inner?.caption || inner?.description || null;
        }

        const quoted_id = message.contextInfo?.stanzaId || message.quoted?.key?.id || null;
        const timestamp = message.messageTimestamp || Math.floor(Date.now() / 1000);

        saveChatMessage({
            id,
            chat_jid,
            sender_jid,
            sender_name,
            text,
            media_type,
            media_caption,
            quoted_id,
            is_from_me,
            timestamp,
        });
    } catch (err) {
        // Logging should never throw or disrupt the message pipeline
        console.error("[MESSAGE_LOGGER] Error saving chat message:", err.message);
    }
}

