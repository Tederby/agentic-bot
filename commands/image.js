import { generateImage } from "../services/imageService.js";

export default {
    name: "image",
    aliases: ["img", "gambar", "draw", "generate"],
    category: "tools",
    description: "Generate gambar AI dari deskripsi teks",
    usage: "!image <deskripsi>",
    multiBot: true,

    async handler({ message, sock, rawArgs, prefix, commandName }) {
        const prompt = (rawArgs || "").trim();

        if (!prompt) {
            return message.reply(
                `🎨 *AI IMAGE GENERATOR*\n` +
                `────────────────────────\n` +
                `*📖 Format:* \`${prefix}${commandName} <deskripsi>\`\n` +
                `*💡 Contoh:* \`${prefix}${commandName} kucing astronot di bulan, 4k digital art\`\n` +
                `────────────────────────`
            );
        }

        await message.react("⏳");

        try {
            const imageBuffer = await generateImage(prompt, { width: 1024, height: 1024 });

            await sock.sendMessage(
                message.chat,
                {
                    image: imageBuffer,
                    caption: `🎨 *Prompt:* "${prompt}"\n_Generated via AI_`,
                },
                { quoted: message }
            );

            await message.react("✅");
        } catch (err) {
            await message.react("❌");
            console.error("[IMAGE_COMMAND] Error:", err.message);
            await message.reply(`❌ Gagal membuat gambar: ${err.message || "Terjadi kesalahan koneksi"}`);
        }
    },
};
