/**
 * Message Handler — Clean Pipeline Architecture
 *
 * Pipeline: guard → ban-check → context → reply-handler → auto-detect → parse → spam-filter → permissions → auto-register → flag-parsing → execute
 *
 * Each step is clearly separated. Adding new middleware (e.g. owner-only check,
 * group-only check) is straightforward via declarative command flags.
 */

import { msgFilter } from "./lib/utils.js";
import { parseCommand } from "./lib/commandParser.js";
import { parseFlags } from "./lib/flagParser.js";
import { getCommand, getReplyHandler } from "./commands/_registry.js";
import { buildContext } from "./lib/contextBuilder.js";
import { runAutoDetects } from "./lib/autoDetect.js";
import { logger } from "./lib/logger.js";
import { checkPermissions } from "./lib/middleware.js";
import { isBanned, isGroupBanned, isUserGroupBanned, getActiveBotsInGroup, claimMessage, getGroupConfig, isRegistered, registerUser, isAiGlobalEnabled, getAiChatSettings, isUserAiIgnored, resolveUserId } from "./lib/database.js";
import { logMessage } from "./lib/messageLogger.js";
import { enqueueAiTrigger, handleManualInterrupt, isDebounceActive, isAiMessage } from "./lib/aiQueue.js";
import setting from "./setting.js";

// ── Blocklist Cache (avoid network call per-message) ────────────────────────
let _blocklistCache = [];
let _blocklistTimestamp = 0;
const BLOCKLIST_TTL = 60_000; // 60 seconds

async function getCachedBlocklist(sock) {
    const now = Date.now();
    if (now - _blocklistTimestamp > BLOCKLIST_TTL) {
        try {
            _blocklistCache = await sock.fetchBlocklist();
            _blocklistTimestamp = now;
        } catch {
            // Connection not ready or network error — use stale cache
        }
    }
    return _blocklistCache;
}

let msgHandler = async (upsert, sock, message) => {
    try {
        let { text } = message;
        text = text || "";

        // ── Guard: empty sender ─────────────────────────────────────
        if (message.sender === "") return;

        const t = message.messageTimestamp;

        // ── Ignore offline replay (prevent double processing) ───────
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec - t > 120) return;

        // ── Build context ───────────────────────────────────────────
        const ctx = await buildContext(message, sock);
        if (!ctx.sender) return;

        // ── Message Ingestion (Sliding Window History) ──────────────
        logMessage(message);

        // ── Manual Override (User types manually → cancel AI queue) ──
        if (message.key.fromMe && !isAiMessage(message)) {
            handleManualInterrupt(message.chat);
        }

        // ── [OPTIONAL] Ban checks (silent drop — no response) ───────
        // Built-in ban system. Remove these lines if you don't
        // need user/group banning in your bot.
        if (ctx.isGroup && isGroupBanned(message.chat)) return;
        if (isBanned(ctx.sender)) return;
        if (ctx.isGroup && isUserGroupBanned(message.chat, ctx.sender)) return;

        // ── 1. Command Parsing ──────────────────────────────────────
        const parsed = parseCommand(text);
        const cmd = parsed ? getCommand(parsed.commandName) : null;

        // ── Block check (group only) ────────────────────────────────
        if (ctx.isGroup) {
            const listBlocked = await getCachedBlocklist(sock);
            if (listBlocked.includes(ctx.sender)) return;
            
            // ── Multi-Bot Priority Claim ────────────────────────────
            const botId = process.env.BOT_ID || setting.botId || "bot";
            const participants = ctx.groupMetadata?.participants;
            
            const myJid = sock.user.id.includes(":") ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : sock.user.id;
            const myCanonicalJid = resolveUserId(myJid);
            const myNumber = myCanonicalJid.split("@")[0];
            const myLid = sock.user?.lid ? (sock.user.lid.includes(":") ? sock.user.lid.split(":")[0] + "@lid" : sock.user.lid) : null;
            const myLidNumber = myLid ? myLid.split("@")[0] : null;

            const quotedSender = message.quoted?.sender ? resolveUserId(message.quoted.sender) : null;
            const isQuotedMe = message.quoted?.key?.fromMe || (quotedSender && (quotedSender === myCanonicalJid || (myLid && quotedSender === myLid)));

            const isMentioned = message.mentionMe || 
                (Array.isArray(message.mentionedJid) && message.mentionedJid.some(j => {
                    const norm = resolveUserId(j);
                    return norm.includes(myNumber) || (myLidNumber && norm.includes(myLidNumber));
                }));

            const isDirectlyTargetingMe = isMentioned || isQuotedMe;

            // Direct mentions/quotes targeted to THIS bot bypass general multi-bot claim
            if (participants && participants.length > 0 && !(cmd && cmd.multiBot) && !isDirectlyTargetingMe) {
                const participantJids = participants.map(p => p.id);
                const activeBots = getActiveBotsInGroup(participantJids);
                
                const myIndex = activeBots.indexOf(myJid);
                
                if (myIndex > 0) {
                    // Delay 1.5s per priority level (index 0 = 0s)
                    await new Promise(resolve => setTimeout(resolve, myIndex * 1500));
                }
                
                const stanzaId = message.key.id;
                const claimed = claimMessage(stanzaId, botId);
                if (!claimed) {
                    return; // Already claimed by a higher-priority bot
                }
            }
        }

        // ── 2. Reply Handler Interception ───────────────────────────
        // Catches replies to multi-step commands (e.g. ytdlf format selection)
        // If it's a valid command, we bypass the reply handler and execute the command.
        if (message.quoted && message.contextInfo?.stanzaId && !cmd) {
            const entry = getReplyHandler(message.contextInfo.stanzaId);
            if (entry) {
                if (!entry.state.allowAnyUser && entry.state.userId !== ctx.sender) {
                    await message.reply("❌ Only the original sender can interact with this.");
                    return;
                }
                logger.exec(t, `reply:${entry.state.commandName || "unknown"}`, ctx.pushname, ctx.isGroup, ctx.groupName);
                await sock.readMessages([message.key]);
                await entry.handler({ message, sock, state: entry.state });
                return;
            }
        }

        // ── 3. Auto-Detect (modular pattern matching) ───────────────
        // Only run auto-detect if the message is NOT a valid explicit command.
        // This prevents auto-detect from intercepting commands like `!register steam <link>`
        if (!cmd) {
            const detection = await runAutoDetects(text, message, sock);
            if (detection.matched) {
                logger.autoDetect(t, detection.name, ctx.pushname, ctx.isGroup, ctx.groupName);
                await sock.readMessages([message.key]);
                return;
            }

            // ── AI Userbot Trigger Evaluation ───────────────────────
            if (isAiGlobalEnabled() && !message.key.fromMe) {
                const chatSettings = getAiChatSettings(message.chat);
                // DMs are enabled by default when global AI is ON, unless explicitly turned off (enabled === false).
                // Groups require chatSettings.enabled === true.
                const isChatEnabled = chatSettings ? chatSettings.enabled : (!ctx.isGroup);

                const myJid = sock.user.id.includes(":") ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : sock.user.id;
                const myCanonicalJid = resolveUserId(myJid);
                const myNumber = myCanonicalJid.split("@")[0];
                const myLid = sock.user?.lid ? (sock.user.lid.includes(":") ? sock.user.lid.split(":")[0] + "@lid" : sock.user.lid) : null;
                const myLidNumber = myLid ? myLid.split("@")[0] : null;

                const quotedSender = message.quoted?.sender ? resolveUserId(message.quoted.sender) : null;
                const isQuotedMe = message.quoted?.key?.fromMe || (quotedSender && (quotedSender === myCanonicalJid || (myLid && quotedSender === myLid)));

                const isMentioned = message.mentionMe || 
                    (Array.isArray(message.mentionedJid) && message.mentionedJid.some(j => {
                        const norm = resolveUserId(j);
                        return norm.includes(myNumber) || (myLidNumber && norm.includes(myLidNumber));
                    }));

                if (isChatEnabled) {
                    const isIgnored = ctx.isGroup && isUserAiIgnored(message.chat, ctx.sender);
                    if (!isIgnored) {
                        const isChatDebouncing = isDebounceActive(message.chat, ctx.sender, ctx.isGroup);
                        let isTriggered = false;

                        if (!ctx.isGroup) {
                            // DM: All incoming messages from partner trigger AI
                            isTriggered = true;
                        } else if (isChatDebouncing) {
                            // Group: Debounce session is ALREADY ACTIVE for this specific user!
                            // Subsequent chat messages from this user extend the idle timer and get bundled!
                            isTriggered = true;
                        } else if ((chatSettings?.mode || "trigger") === "all") {
                            // Group: Mode "all" responds to every chat message
                            isTriggered = true;
                        } else if ((chatSettings?.mode || "trigger") === "trigger") {
                            // Group: Tagged/mentioned or replying to userbot's message
                            if (isMentioned || isQuotedMe) {
                                isTriggered = true;
                            }
                        }

                        if (isTriggered) {
                            if (isChatDebouncing) {
                                logger.info("AI:BUFFER", `Incoming subsequent chat from ${ctx.pushname} in ${ctx.isGroup ? ctx.groupName : "DM"} → Updating debounce timer (+3s idle)`);
                            } else {
                                logger.info("AI:TRIGGER", `Incoming message from ${ctx.pushname} in ${ctx.isGroup ? ctx.groupName : "DM"} → Enqueueing AI (debounce 3.5s)`);
                            }
                            enqueueAiTrigger({ message, sock, ctx });
                            return;
                        }
                    } else {
                        logger.info("AI:IGNORE", `User ${ctx.pushname} is in AI ignore list for ${ctx.groupName}`);
                    }
                } else {
                    if (!ctx.isGroup) {
                        logger.warn("AI:SKIPPED", `DM from ${ctx.pushname} skipped: AI is OFF for this chat. (Send '!ai chat on' to enable)`);
                    } else if (isMentioned || isQuotedMe) {
                        logger.warn("AI:SKIPPED", `Tag received from ${ctx.pushname} in ${ctx.groupName}, but AI is OFF in this group. (Send '!ai chat on' in this group to enable)`);
                    }
                }
            } else if (!isAiGlobalEnabled() && !message.key.fromMe) {
                const isTag = message.mentionMe || (Array.isArray(message.mentionedJid) && message.mentionedJid.length > 0);
                if (!ctx.isGroup || isTag) {
                    logger.warn("AI:SKIPPED", `Message from ${ctx.pushname} skipped: Master Switch AI is globally OFF. (Send '!ai on' to enable)`);
                }
            }
        }

        // ── 4. Process Command ──────────────────────────────────────
        if (!parsed) return;
        if (!cmd) return;

        const { prefix, commandName, args, rawArgs } = parsed;

        const cmdLabel = `${prefix}${commandName} [${args.length}]`;

        // ── 5. Spam Filter (per-user per-chat) ──────────────────────
        const spamKey = `${ctx.sender}_${message.chat}`;
        if (msgFilter.isFiltered(spamKey)) {
            return logger.spam(t, cmdLabel, ctx.pushname, ctx.isGroup, ctx.groupName);
        }
        msgFilter.addFilter(spamKey, setting.spamDelay);

        // ── 6. Permission Guard (Middleware) ────────────────────────
        const guardMsg = checkPermissions(cmd, { ...ctx, chatId: message.chat });
        
        if (cmd.ownerOnly) {
            const status = guardMsg ? "BLOCKED" : "ALLOWED";
            logger.auth(t, cmdLabel, ctx.pushname, ctx.isGroup, ctx.groupName, status);
        }

        if (guardMsg) {
            if (guardMsg !== "SILENT_DROP") {
                await message.reply(guardMsg);
            }
            return;
        }

        // ── 7. Auto-Register (silent) ────────────────────────────────
        // If user is not yet registered in the database, silently
        // register them using their pushname as display name.
        if (!isRegistered(ctx.sender)) {
            registerUser(ctx.sender, ctx.pushname);
        }

        // ── 8. Flag Parsing (declarative POSIX flags) ──────────────
        let parsedFlags = {};
        let effectiveArgs = args;
        let cleanArgs = args;

        if (cmd.flags) {
            const flagResult = parseFlags(args, cmd.flags);
            parsedFlags = flagResult.flags;
            cleanArgs = flagResult.cleanArgs;
            effectiveArgs = flagResult.cleanArgs;
        }

        // ── 9. Log & Execute ────────────────────────────────────────
        logger.exec(t, cmdLabel, ctx.pushname, ctx.isGroup, ctx.groupName);
        await sock.readMessages([message.key]);

        await cmd.handler({
            message,
            sock,
            upsert,
            chat: message.chat,
            chatId: message.chat,
            args: effectiveArgs,
            cleanArgs,
            rawArgs,
            flags: parsedFlags,
            prefix,
            commandName,
            ...ctx,
        });

    } catch (err) {
        logger.error("HANDLER", err);
    }
};

export { msgHandler };
export default msgHandler;
