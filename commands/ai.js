/**
 * Command: !ai
 * Master control for AI Persona / Agentic Userbot
 *
 * Scope: Universal & Per-Chat
 * Security: Owner-Only
 */

import {
    isAiGlobalEnabled,
    getAiGlobalConfig,
    setAiGlobalConfig,
    deleteAiGlobalConfig,
    getAiChatSettings,
    setAiChatSettings,
    isUserAiIgnored,
    addAiIgnore,
    removeAiIgnore,
    getAiIgnores,
} from "../lib/database.js";
import { extractTarget } from "../lib/jidHelper.js";
import { getFilePersona } from "../lib/aiContextBuilder.js";

export default {
    name: "ai",
    aliases: ["agent", "userbot"],
    category: "ai",
    description: "Control AI persona and userbot automation settings.",
    usage: "!ai <status|on|off|chat on|chat off|mode|ignore|persona>",
    ownerOnly: true,

    async handler(params) {
        const { message, args, isGroup, prefix, commandName } = params;
        const chat = params.chat || params.chatId || message?.chat;
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
            if (mode !== "trigger" && mode !== "command" && mode !== "all") {
                return message.reply(`❌ Pilihan mode yang valid:\n⋄ *trigger* : Merespons saat di-tag/reply (pesan lanjutan ter-debounce otomatis)\n⋄ *all* : Merespons setiap chat di grup secara otomatis\n⋄ *command* : Hanya aktif via perintah khusus`);
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

        // ── 6. Persona Management ───────────────────────────────────
        if (sub === "persona") {
            const action = (args[1] || "").toLowerCase();
            const chatSettings = getAiChatSettings(chat);
            const globalPersona = getAiGlobalConfig("default_persona", null);
            const filePersona = getFilePersona();

            if (!action || action === "show" || action === "status") {
                let text = `🎭 *PENGATURAN PERSONA AI*\n`;
                text += `────────────────────────\n`;

                const activeSource = chatSettings?.custom_persona
                    ? "Chat Khusus Ini"
                    : globalPersona
                    ? "Database Global"
                    : filePersona
                    ? "File (persona.txt)"
                    : "Default Bawaan Kode";

                text += `⋄ Sumber Aktif : *${activeSource}*\n`;
                text += `⋄ Chat Ini     : ${chatSettings?.custom_persona ? `"${chatSettings.custom_persona.slice(0, 80)}..."` : "(Mengikuti Global / File)"}\n`;
                text += `⋄ DB Global    : ${globalPersona ? `"${globalPersona.slice(0, 80)}..."` : "(Tidak diatur di DB)"}\n`;
                text += `⋄ persona.txt  : ${filePersona ? `Aktif (${filePersona.length} karakter)` : "(Tidak ada / Kosong)"}\n`;
                text += `────────────────────────\n`;
                text += `*Opsi Pengaturan Command:*\n`;
                text += `⋄ Persona chat ini : \`${prefix}${commandName} persona set <teks>\`\n`;
                text += `⋄ Reset chat ini   : \`${prefix}${commandName} persona reset\`\n`;
                text += `⋄ Persona global   : \`${prefix}${commandName} persona global <teks>\`\n`;
                text += `⋄ Reset DB global  : \`${prefix}${commandName} persona global reset\`\n`;
                text += `⋄ Cek persona.txt  : \`${prefix}${commandName} persona reload\`\n\n`;
                text += `💡 _Tips: Anda juga bisa mengedit langsung file \`persona.txt\` di root project untuk kustomisasi panjang tanpa batasan teks WhatsApp!_`;
                return message.reply(text);
            }

            if (action === "reload" || action === "file") {
                if (filePersona) {
                    const lines = filePersona.split("\n").length;
                    return message.reply(`✅ *File persona.txt terdeteksi aktif!*\nPanjang: ${filePersona.length} karakter (${lines} baris).\n\n*Preview:*\n${filePersona.slice(0, 300)}${filePersona.length > 300 ? "..." : ""}`);
                } else {
                    return message.reply(`⚠️ File \`persona.txt\` tidak ditemukan atau masih kosong di root project bot.\nBuat atau isi file tersebut untuk menggunakan persona berbasis file.`);
                }
            }

            if (action === "set") {
                const newPersona = args.slice(2).join(" ").trim();
                if (!newPersona) {
                    return message.reply(`❌ Masukkan teks persona baru.\nContoh: \`${prefix}${commandName} persona set Kamu adalah asisten ahli coding.\``);
                }
                setAiChatSettings(chat, { custom_persona: newPersona });
                return message.reply(`✅ *Persona khusus berhasil disetel untuk chat ini:*\n"${newPersona}"`);
            }

            if (action === "reset") {
                setAiChatSettings(chat, { custom_persona: null });
                return message.reply(`✅ *Persona chat ini di-reset* (kembali mengikuti persona global/file).`);
            }

            if (action === "global") {
                const opt = (args[2] || "").toLowerCase();
                if (opt === "reset" || opt === "clear") {
                    deleteAiGlobalConfig("default_persona");
                    return message.reply(`✅ *Persona global database di-reset!* Sekarang AI akan mengikuti \`persona.txt\` atau default kode.`);
                }

                const newGlobal = args.slice(2).join(" ").trim();
                if (!newGlobal) {
                    return message.reply(`❌ Masukkan teks persona global baru atau gunakan \`${prefix}${commandName} persona global reset\` untuk mereset.`);
                }
                setAiGlobalConfig("default_persona", newGlobal);
                return message.reply(`✅ *Persona global default berhasil diperbarui:*\n"${newGlobal}"`);
            }

            return message.reply(`❌ Aksi persona tidak valid. Gunakan: \`${prefix}${commandName} persona [set|reset|global|reload]\``);
        }

        // ── Help Fallback ───────────────────────────────────────────
        const helpText = 
`📖 *PANDUAN COMMAND ${prefix}${commandName.toUpperCase()}*
────────────────────────
⋄ \`${prefix}${commandName} status\` : Cek status AI global & chat
⋄ \`${prefix}${commandName} on / off\` : Saklar master global
⋄ \`${prefix}${commandName} chat on / off\` : Saklar khusus chat ini
⋄ \`${prefix}${commandName} mode <trigger|command>\` : Sensitivitas pemicu
⋄ \`${prefix}${commandName} persona [set|reset|global]\` : Kustomisasi persona
⋄ \`${prefix}${commandName} ignore add @user\` : Abaikan user di grup
⋄ \`${prefix}${commandName} ignore del @user\` : Batal abaikan user
⋄ \`${prefix}${commandName} ignore list\` : Lihat daftar abaikan`;

        return message.reply(helpText);
    },
};

