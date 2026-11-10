/**
 * Image Generation Service
 *
 * Generates images via high-speed AI image inference (Pollinations / Flux pipeline)
 * No API key required, returns Buffer ready for Baileys sock.sendMessage().
 */

import axios from "axios";

/**
 * Generate an image from a textual prompt.
 *
 * @param {string} prompt - Detailed image description
 * @param {object} [options]
 * @param {number} [options.width=1024]
 * @param {number} [options.height=1024]
 * @param {number} [options.timeout=35000]
 * @returns {Promise<Buffer>}
 */
export async function generateImage(prompt, options = {}) {
    if (!prompt || typeof prompt !== "string") {
        throw new Error("Prompt is required for image generation.");
    }

    const width = options.width || 1024;
    const height = options.height || 1024;
    const timeout = options.timeout || 35000;

    const cleanPrompt = prompt.trim().replace(/\s+/g, " ");
    const encodedPrompt = encodeURIComponent(cleanPrompt);
    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&enhance=true`;

    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout,
        headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AgenticBot/1.0)",
        },
    });

    if (!response.data || response.data.length < 1000) {
        throw new Error("Invalid image buffer received from generator.");
    }

    return Buffer.from(response.data);
}
