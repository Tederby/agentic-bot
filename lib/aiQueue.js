/**
 * AI Queue — Debounce Buffer & Concurrency Mutex Queue
 *
 * Prevents race conditions and duplicate executions:
 *  - Per-chat 3.5s debounce buffer (aggregates rapid successive messages)
 *  - FIFO mutex lock per chat (one AI call at a time per chatJid)
 *  - Manual interrupt handler (aborts queue/execution if owner types manually)
 *  - Native WhatsApp presence indicator ('composing' / 'paused')
 */

import { buildAiPrompt } from "./aiContextBuilder.js";
import { generateAiReply } from "../services/aiEngine.js";
import { logger } from "./logger.js";
import setting from "../setting.js";

const DEBOUNCE_MS = Number(process.env.AI_DEBOUNCE_MS) || 3500;

// Debounce state: chatJid -> { timer, messages: [], ctx, sock }
const debounceBuffers = new Map();

// Concurrency state: chatJid -> { isProcessing: boolean, queue: [] }
const chatQueues = new Map();

// Active abort controllers: chatJid -> AbortController
const activeAbortControllers = new Map();

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
        console.log(`[AI_QUEUE] Debounce buffer cancelled by manual override for ${chatJid}`);
    }

    // 2. Abort ongoing child_process execution
    if (activeAbortControllers.has(chatJid)) {
        const controller = activeAbortControllers.get(chatJid);
        controller.abort();
        activeAbortControllers.delete(chatJid);
        console.log(`[AI_QUEUE] Active AI execution aborted by manual override for ${chatJid}`);
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
        existing.timer = setTimeout(() => flushDebounce(chatJid), DEBOUNCE_MS);
    } else {
        const timer = setTimeout(() => flushDebounce(chatJid), DEBOUNCE_MS);
        debounceBuffers.set(chatJid, {
            timer,
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

    // Combine texts of all accumulated messages
    const combinedText = messages
        .map((m) => m.text)
        .filter(Boolean)
        .join(" \n");

    const lastMessage = messages[messages.length - 1];

    if (!chatQueues.has(chatJid)) {
        chatQueues.set(chatJid, { isProcessing: false, queue: [] });
    }

    const q = chatQueues.get(chatJid);
    q.queue.push({
        chatJid,
        sock,
        ctx,
        lastMessage,
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

    try {
        const { sock, ctx, lastMessage, combinedText } = task;

        // 1. Indicate typing status in WhatsApp
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => {});

        // 2. Build structured sliding-window context prompt
        const { prompt } = await buildAiPrompt({
            chatJid,
            chatName: ctx.groupName || ctx.pushname,
            isGroup: ctx.isGroup,
            ownerName: setting.name || "Owner",
            triggerMessage: lastMessage,
            triggerText: combinedText,
        });

        // 3. Invoke AI engine
        const replyText = await generateAiReply({
            prompt,
            abortSignal: abortController.signal,
        });

        // 4. Send response if not aborted and reply text is present
        if (replyText && !abortController.signal.aborted) {
            await sock.sendMessage(
                chatJid,
                { text: replyText },
                { quoted: lastMessage }
            );

            logger.exec(
                lastMessage.messageTimestamp,
                `AI:Reply [${replyText.length} chars]`,
                ctx.pushname,
                ctx.isGroup,
                ctx.groupName
            );
        }
    } catch (err) {
        if (err.message === "ABORTED_BY_MANUAL_OVERRIDE") {
            console.log(`[AI_QUEUE] Execution gracefully aborted for ${chatJid}`);
        } else {
            console.error(`[AI_QUEUE] Error during AI generation for ${chatJid}:`, err.message);
        }
    } finally {
        activeAbortControllers.delete(chatJid);
        await task.sock.sendPresenceUpdate("paused", chatJid).catch(() => {});
        q.isProcessing = false;

        // Process next queued task if present
        if (q.queue.length > 0) {
            processNextInQueue(chatJid);
        }
    }
}

