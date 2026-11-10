/**
 * AI Queue — Debounce Buffer & Concurrency Mutex Queue
 *
 * Prevents race conditions and duplicate executions:
 *  - Per-chat 3.5s debounce buffer (aggregates rapid successive messages)
 *  - FIFO mutex lock per chat (one AI call at a time per chatJid)
 *  - Manual interrupt handler (aborts queue/execution if owner types manually)
 *  - Native WhatsApp presence indicator ('composing' / 'paused')
 */

import fs from "fs";
import path from "path";
import { buildAiPrompt } from "./aiContextBuilder.js";
import { generateAiReply } from "../services/aiEngine.js";
import { generateImage } from "../services/imageService.js";
import { logger } from "./logger.js";
import { saveChatMessage, resolveUserId } from "./database.js";
import { jidNormalizedUser } from "baileys";
import setting from "../setting.js";
import { resolveSmartMentions } from "./mentionHelper.js";

const INITIAL_DEBOUNCE_MS = Number(process.env.AI_DEBOUNCE_MS) || 3500;
const SUBSEQUENT_DEBOUNCE_MS = Number(process.env.AI_SUBSEQUENT_MS) || 3000;
const MAX_DEBOUNCE_CAP_MS = 20000; // max wait cap: 20 seconds

// ── Seamless AI Watermark & Detection ─────────────────────────────────────────
export const AI_WATERMARK = "\u200B"; // Invisible zero-width space

// Cache of recently sent AI message IDs (FIFO ring buffer)
const aiSentMessageIds = new Set();
const MAX_AI_MESSAGE_IDS = 1000;

/**
 * Register a message ID as sent by AI userbot.
 * @param {string} id - WhatsApp message ID
 */
export function markAsAiMessage(id) {
    if (!id) return;
    aiSentMessageIds.add(id);
    if (aiSentMessageIds.size > MAX_AI_MESSAGE_IDS) {
        const first = aiSentMessageIds.values().next().value;
        aiSentMessageIds.delete(first);
    }
}

/**
 * Determine whether a message was generated and sent by the AI userbot.
 * Checks in-memory message ID cache, text watermark, and media caption.
 *
 * @param {object} message - WAMessage or message object
 * @returns {boolean}
 */
export function isAiMessage(message) {
    if (!message) return false;
    const id = message.id || message.key?.id;
    if (id && aiSentMessageIds.has(id)) return true;
    const text = message.text || message.caption || "";
    if (typeof text === "string" && text.includes(AI_WATERMARK)) return true;
    if (message.message) {
        const mtype = message.mtype || message.type || Object.keys(message.message)[0];
        const inner = message.message[mtype];
        const cap = inner?.caption || inner?.text || "";
        if (typeof cap === "string" && cap.includes(AI_WATERMARK)) return true;
    }
    return false;
}

// Debounce state: chatJid -> { timer, messages: [], ctx, sock }
const debounceBuffers = new Map();

// Concurrency state: chatJid -> { isProcessing: boolean, queue: [] }
const chatQueues = new Map();

// Active abort controllers: chatJid -> AbortController
const activeAbortControllers = new Map();

/**
 * Check if a debounce buffer is currently active for a chat.
 * @param {string} chatJid
 * @returns {boolean}
 */
export function isDebounceActive(chatJid) {
    return debounceBuffers.has(chatJid);
}

/**
 * Cancel any pending debounce timer or running AI execution for this chat.
 * Triggered when the account owner sends a manual message.
 *
 * @param {string} chatJid
 */
export function handleManualInterrupt(chatJid) {
    if (!chatJid) return;

    // 1. Cancel pending debounce buffer
    if (debounceBuffers.has(chatJid)) {
        const item = debounceBuffers.get(chatJid);
        clearTimeout(item.timer);
        debounceBuffers.delete(chatJid);
        logger.warn("AI:OVERRIDE", `Debounce buffer cancelled by manual message for ${chatJid}`);
    }

    // 2. Abort ongoing child_process execution
    if (activeAbortControllers.has(chatJid)) {
        const controller = activeAbortControllers.get(chatJid);
        controller.abort();
        activeAbortControllers.delete(chatJid);
        logger.warn("AI:OVERRIDE", `Active AI execution aborted by manual message for ${chatJid}`);
    }

    // 3. Clear pending queue
    if (chatQueues.has(chatJid)) {
        const q = chatQueues.get(chatJid);
        q.queue = [];
    }
}

/**
 * Enqueue a message to the AI pipeline with debounce.
 *
 * @param {object} params
 * @param {object} params.message - WAMessage
 * @param {object} params.sock - WASocket
 * @param {object} params.ctx - MessageContext from buildContext
 */
export function enqueueAiTrigger({ message, sock, ctx }) {
    const chatJid = message.chat;
    if (!chatJid) return;

    const existing = debounceBuffers.get(chatJid);
    if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push(message);
        existing.ctx = ctx; // Update with latest context

        // Cap to prevent infinite delay if chatter continues nonstop
        const elapsedSinceFirst = Date.now() - (existing.firstTriggerAt || Date.now());
        if (elapsedSinceFirst >= MAX_DEBOUNCE_CAP_MS) {
            logger.info("AI:BUFFER", `Max debounce cap reached (${MAX_DEBOUNCE_CAP_MS}ms) for ${chatJid}. Flushing bundle...`);
            flushDebounce(chatJid);
            return;
        }

        const remainingToCap = MAX_DEBOUNCE_CAP_MS - elapsedSinceFirst;
        const delay = Math.min(SUBSEQUENT_DEBOUNCE_MS, remainingToCap);

        logger.info("AI:BUFFER", `Pesan tambahan (${existing.messages.length}) diterima dari ${ctx.pushname}. Menunggu jeda idle ${delay}ms...`);
        existing.timer = setTimeout(() => flushDebounce(chatJid), delay);
    } else {
        logger.info("AI:BUFFER", `Trigger awal diterima dari ${ctx.pushname}. Memulai jeda time limit ${INITIAL_DEBOUNCE_MS}ms...`);
        const timer = setTimeout(() => flushDebounce(chatJid), INITIAL_DEBOUNCE_MS);
        debounceBuffers.set(chatJid, {
            timer,
            firstTriggerAt: Date.now(),
            messages: [message],
            ctx,
            sock,
        });
    }
}

/**
 * Flush accumulated messages for a chat into the FIFO execution queue.
 * @param {string} chatJid
 */
function flushDebounce(chatJid) {
    const item = debounceBuffers.get(chatJid);
    if (!item) return;
    debounceBuffers.delete(chatJid);

    const { messages, ctx, sock } = item;
    if (!messages || messages.length === 0) return;

    logger.info("AI:QUEUE", `Debounce closed. Enqueued ${messages.length} message(s) to FIFO queue for ${chatJid}`);

    // Combine texts of all accumulated messages
    const combinedText = messages
        .map((m) => m.text)
        .filter(Boolean)
        .join(" \n");

    const lastMessage = messages[messages.length - 1];
    // Find the message with quoted context if any exists in the debounce bundle
    const quotedMessage = messages.findLast((m) => m.quoted || m.contextInfo?.stanzaId);
    const triggerMessage = quotedMessage || lastMessage;

    if (!chatQueues.has(chatJid)) {
        chatQueues.set(chatJid, { isProcessing: false, queue: [] });
    }

    const q = chatQueues.get(chatJid);
    q.queue.push({
        chatJid,
        sock,
        ctx,
        lastMessage,
        triggerMessage,
        combinedText,
    });

    processNextInQueue(chatJid);
}

/**
 * Process the next item in the chat's FIFO queue.
 * @param {string} chatJid
 */
async function processNextInQueue(chatJid) {
    const q = chatQueues.get(chatJid);
    if (!q || q.isProcessing || q.queue.length === 0) return;

    q.isProcessing = true;
    const task = q.queue.shift();

    const abortController = new AbortController();
    activeAbortControllers.set(chatJid, abortController);

    let presenceHeartbeat = null;
    let activeMediaFile = null;

    try {
        const { sock, ctx, lastMessage, triggerMessage, combinedText } = task;

        // 1. Indicate typing status in WhatsApp with recurring heartbeat
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => {});
        presenceHeartbeat = setInterval(() => {
            sock.sendPresenceUpdate("composing", chatJid).catch(() => {});
        }, 8000);

        logger.info("AI:BUILD", `Reconstructing context history for ${chatJid}...`);

        // 2. Build structured sliding-window context prompt
        const { prompt, triggerMediaFile } = await buildAiPrompt({
            chatJid,
            chatName: ctx.groupName || ctx.pushname,
            isGroup: ctx.isGroup,
            ownerName: setting.name || "Owner",
            triggerMessage: triggerMessage || lastMessage,
            triggerText: combinedText,
            groupMetadata: ctx.groupMetadata,
        });
        activeMediaFile = triggerMediaFile;

        logger.info("AI:THINKING", `Spawning agy CLI (prompt: ${prompt.length} chars) for ${chatJid}...`);

        // 3. Invoke AI engine
        const replyText = await generateAiReply({
            prompt,
            abortSignal: abortController.signal,
        });

        // 4. Send response if not aborted and reply text is present
        if (replyText && !abortController.signal.aborted) {
            const imgMatch = replyText.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/i);
            let sentMsg = null;
            let loggedMediaType = null;
            let loggedMediaCaption = null;
            let loggedText = replyText;

            // Resolve smart mentions for the message
            const { text: resolvedText, mentions } = resolveSmartMentions(replyText, {
                chatJid,
                groupMetadata: ctx.groupMetadata,
                triggerMessage: triggerMessage || lastMessage,
            });

            if (imgMatch) {
                const imagePrompt = imgMatch[1].trim();
                const rawCaption = replyText.replace(/\[GENERATE_IMAGE:\s*[^\]]+\]/i, "").trim();
                const { text: resolvedCaption, mentions: captionMentions } = resolveSmartMentions(rawCaption, {
                    chatJid,
                    groupMetadata: ctx.groupMetadata,
                    triggerMessage: triggerMessage || lastMessage,
                });

                logger.info("AI:IMAGE", `Detected image request: "${imagePrompt}". Generating image...`);

                try {
                    const imageBuf = await generateImage(imagePrompt, { width: 1024, height: 1024 });
                    logger.info("AI:IMAGE", `Image generated (${imageBuf.length} bytes). Sending to ${chatJid}...`);

                    const finalImageCaption = resolvedCaption ? `${resolvedCaption}${AI_WATERMARK}` : AI_WATERMARK;
                    sentMsg = await sock.sendMessage(
                        chatJid,
                        {
                            image: imageBuf,
                            caption: finalImageCaption,
                            mentions: captionMentions.length > 0 ? captionMentions : undefined,
                        },
                        { quoted: lastMessage }
                    );

                    loggedMediaType = "image";
                    loggedMediaCaption = resolvedCaption || imagePrompt;
                    loggedText = resolvedCaption || `[Mengirim foto: ${imagePrompt}]`;
                } catch (imgErr) {
                    logger.error("AI:IMAGE_ERROR", `Failed to generate image: ${imgErr.message}. Falling back to text.`);
                    const fallbackText = resolvedCaption 
                        ? `${resolvedCaption}\n\n_(Gagal membuat gambar: ${imgErr.message})_` 
                        : `Maaf, gagal membuat gambar barusan: ${imgErr.message}`;

                    sentMsg = await sock.sendMessage(
                        chatJid,
                        {
                            text: `${fallbackText}${AI_WATERMARK}`,
                            mentions: captionMentions.length > 0 ? captionMentions : undefined,
                        },
                        { quoted: lastMessage }
                    );
                    loggedText = fallbackText;
                }
            } else {
                logger.info("AI:SENDING", `Sending reply (${resolvedText.length} chars, ${mentions.length} mentions) to ${chatJid}...`);
                sentMsg = await sock.sendMessage(
                    chatJid,
                    {
                        text: `${resolvedText}${AI_WATERMARK}`,
                        mentions: mentions.length > 0 ? mentions : undefined,
                    },
                    { quoted: lastMessage }
                );
                loggedText = resolvedText;
            }

            // Register message ID in AI cache immediately to prevent manual interrupt race
            if (sentMsg?.key?.id) {
                markAsAiMessage(sentMsg.key.id);
            }

            // Log bot's own response to SQLite for immediate conversation history synchronization
            if (sentMsg?.key?.id) {
                try {
                    const myJid = resolveUserId(jidNormalizedUser(sock.user.id));
                    saveChatMessage({
                        id: sentMsg.key.id,
                        chat_jid: chatJid,
                        sender_jid: myJid,
                        sender_name: setting.name || "You",
                        text: loggedText,
                        media_type: loggedMediaType,
                        media_caption: loggedMediaCaption,
                        quoted_id: lastMessage.key?.id || null,
                        is_from_me: 1,
                        is_ai: 1,
                        timestamp: Math.floor(Date.now() / 1000),
                    });
                } catch (saveErr) {
                    console.error("[AI_QUEUE] Error saving bot response message:", saveErr.message);
                }
            }

            logger.exec(
                lastMessage.messageTimestamp,
                loggedMediaType === "image" ? `AI:ImageReply [${loggedText.length} chars]` : `AI:Reply [${replyText.length} chars]`,
                ctx.pushname,
                ctx.isGroup,
                ctx.groupName
            );
        } else if (!replyText) {
            logger.warn("AI:EMPTY", `agy returned empty output for ${chatJid}`);
        }
    } catch (err) {
        if (err.message === "ABORTED_BY_MANUAL_OVERRIDE") {
            logger.warn("AI:ABORT", `Execution gracefully aborted for ${chatJid} by manual override`);
        } else {
            logger.error("AI:EXEC_ERROR", `Error during AI generation for ${chatJid}: ${err.message}`);
        }
    } finally {
        if (activeMediaFile && fs.existsSync(activeMediaFile)) {
            try {
                fs.unlinkSync(activeMediaFile);
                logger.info("AI:VISION", `Cleaned up temp vision image: ${path.basename(activeMediaFile)}`);
            } catch {}
        }
        if (presenceHeartbeat) {
            clearInterval(presenceHeartbeat);
        }
        activeAbortControllers.delete(chatJid);
        await task.sock.sendPresenceUpdate("paused", chatJid).catch(() => {});
        q.isProcessing = false;

        // Process next queued task if present, otherwise prune empty queue map entry
        if (q.queue.length > 0) {
            processNextInQueue(chatJid);
        } else {
            chatQueues.delete(chatJid);
        }
    }
}

