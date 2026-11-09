/**
 * Command: !ai
 * Master control for AI Persona / Agentic Userbot
 *
 * Scope: Universal & Per-Chat
 * Security: Owner-Only
 */

import {
    isAiGlobalEnabled,
    setAiGlobalConfig,
    getAiChatSettings,
    setAiChatSettings,
    isUserAiIgnored,
    addAiIgnore,
    removeAiIgnore,
    getAiIgnores,
} from "../lib/database.js";
import { extractTarget } from "../lib/jidHelper.js";

export default {
    name: "ai",
    aliases: ["agent", "userbot"],
    category: "ai",
    description: "Control AI persona and userbot automation settings.",
    usage: "!ai <status|on|off|chat on|chat off|mode|ignore>",
    ownerOnly: true,

    async handler({ message, args, isGroup, chat, prefix, commandName }) {
        const sub = (args[0] || "status").toLowerCase();

        // ── 1. Status ───────────────────────────────────────────────
        if (sub === "status") {
            const globalOn = isAiGlobalEnabled();
            const chatSettings = getAiChatSettings(chat);
            const ignores = isGroup ? getAiIgnores(chat) : [];

            let text = `🤖 *AI USERBOT STATUS*\n`;
            text += `────────────────────────\n`;
            text += `⋄ Global Switch : *${globalOn ? "ON 🟢" : "OFF 🔴"}*\n`;
            text += `⋄ Chat Switch   : *${chatSettings?.enabled ? "ON 🟢" : "OFF 🔴"}*\n`;
            text += `⋄ Mode          : *${chatSettings?.mode || "trigger"}*\n`;
            
            if (isGroup) {
                text += `⋄ Ignored Users : *${ignores.length} member*\n`;
                if (ignores.length > 0) {
                    text += `────────────────────────\n`;
                    text += `*Daftar Ignore:*\n`;
                    ignores.forEach((ig, idx) => {
                        const num = ig.user_jid.split("@")[0];
                        text += ` ${idx + 1}. @${num}\n`;
                    });
                }
            }
            text += `────────────────────────\n`;
            text += `_Ketik \`${prefix}${commandName} help\` untuk melihat opsi._`;

            return message.reply(text);
        }

        // ── 2. Global On / Off ──────────────────────────────────────
        if (sub === "on") {
            setAiGlobalConfig("enabled", "1");
            return message.reply(`✅ *Master Switch AI diaktifkan secara GLOBAL.*`);
        }

        if (sub === "off") {
            setAiGlobalConfig("enabled", "0");
            return message.reply(`🛑 *Master Switch AI dimatikan secara GLOBAL.*`);
        }

        // ── 3. Per-Chat On / Off ────────────────────────────────────
        if (sub === "chat") {
            const opt = (args[1] || "").toLowerCase();
            if (opt === "on") {
                setAiChatSettings(chat, { enabled: true });
                return message.reply(`✅ *AI diaktifkan untuk chat ini.*`);
            } else if (opt === "off") {
                setAiChatSettings(chat, { enabled: false });
                return message.reply(`🛑 *AI dinonaktifkan untuk chat ini.*`);
            } else {
                return message.reply(`❌ Gunakan: \`${prefix}${commandName} chat on\` atau \`${prefix}${commandName} chat off\``);
            }
        }

        // ── 4. Trigger Mode ─────────────────────────────────────────
        if (sub === "mode") {
            const mode = (args[1] || "").toLowerCase();
            if (mode !== "trigger" && mode !== "command") {
                return message.reply(`❌ Pilihan mode yang valid: *trigger* (tag/reply/DM) atau *command*`);
            }
            setAiChatSettings(chat, { mode });
            return message.reply(`✅ Mode AI untuk chat ini diubah ke: *${mode}*`);
        }

        // ── 5. Ignore List Management (Group only) ──────────────────
        if (sub === "ignore") {
            if (!isGroup) {
                return message.reply(`❌ Pengaturan ignore hanya berlaku di grup.`);
            }

            const action = (args[1] || "list").toLowerCase();

            if (action === "list") {
                const list = getAiIgnores(chat);
                if (list.length === 0) {
                    return message.reply(`ℹ️ Tidak ada user yang di-ignore di grup ini.`);
                }
                let resp = `📋 *DAFTAR IGNORE GRUP INI:*\n────────────────────────\n`;
                list.forEach((item, idx) => {
                    const baseId = item.user_jid.split("@")[0];
                    resp += `${idx + 1}. @${baseId}\n`;
                });
                return message.reply(resp);
            }

            // Target extraction (mention / quoted / manual number)
            const target = extractTarget(message, args.slice(2));
            if (!target || !target.jid) {
                return message.reply(`❌ Tag atau sebutkan nomor target yang ingin di-ignore.\nContoh: \`${prefix}${commandName} ignore add @user\``);
            }

            if (action === "add") {
                const added = addAiIgnore(chat, target.jid);
                if (added) {
                    return message.reply(`✅ User @${target.baseId} dimasukkan ke daftar ignore AI grup ini.`);
                } else {
                    return message.reply(`ℹ️ User @${target.baseId} sudah berada dalam daftar ignore.`);
                }
            }

            if (action === "del" || action === "remove") {
                const removed = removeAiIgnore(chat, target.jid);
                if (removed) {
                    return message.reply(`✅ User @${target.baseId} dihapus dari daftar ignore AI.`);
                } else {
                    return message.reply(`ℹ️ User @${target.baseId} tidak ditemukan dalam daftar ignore.`);
                }
            }

            return message.reply(`❌ Subcommand ignore tidak valid. Gunakan: add, del, atau list.`);
        }

        // ── Help Fallback ───────────────────────────────────────────
        const helpText = 
`📖 *PANDUAN COMMAND ${prefix}${commandName.toUpperCase()}*
────────────────────────
⋄ \`${prefix}${commandName} status\` : Cek status AI global & chat
⋄ \`${prefix}${commandName} on / off\` : Saklar master global
⋄ \`${prefix}${commandName} chat on / off\` : Saklar khusus chat ini
⋄ \`${prefix}${commandName} mode <trigger|command>\` : Sensitivitas pemicu
⋄ \`${prefix}${commandName} ignore add @user\` : Abaikan user di grup
⋄ \`${prefix}${commandName} ignore del @user\` : Batal abaikan user
⋄ \`${prefix}${commandName} ignore list\` : Lihat daftar abaikan`;

        return message.reply(helpText);
    },
};

