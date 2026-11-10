/**
 * AI Engine — Execution Bridge for Antigravity (agy) CLI
 *
 * Spawns non-interactive print mode:
 *   agy -p "<prompt>" --effort low --disable-slash-commands --dangerously-skip-permissions
 *
 * Cross-platform: Uses `agy` in PATH (Linux VPS) or fallback to local path on Windows.
 */

import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import setting from "../setting.js";

/**
 * Determine the executable binary path for agy.
 * @returns {string}
 */
export function getAgyBinPath() {
    if (process.env.AGY_BIN_PATH) {
        return process.env.AGY_BIN_PATH;
    }
    if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE || "C:\\Users\\user";
        const localAgy = path.join(userProfile, ".gemini", "bin", "agy.exe");
        if (fs.existsSync(localAgy)) {
            return localAgy;
        }
    }
    return "agy";
}

/**
 * Ensures an isolated profile directory for agy so it doesn't pollute the user's main environment.
 * @returns {string} Path to the isolated profile directory.
 */
export function getIsolatedBotProfileDir() {
    const isWindows = process.platform === "win32";
    const primaryHome = isWindows
        ? (process.env.USERPROFILE || "C:\\Users\\user")
        : (process.env.HOME || "/root");

    const botHome = path.join(primaryHome, ".gemini-bot-profile");
    const targetCliDir = path.join(botHome, ".gemini", "antigravity-cli");
    const sourceCliDir = path.join(primaryHome, ".gemini", "antigravity-cli");

    if (!fs.existsSync(targetCliDir)) {
        fs.mkdirSync(targetCliDir, { recursive: true });
    }

    // Link or copy essential auth files only (do not copy host settings.json)
    const essentialFiles = ["antigravity-oauth-token", "installation_id"];
    for (const file of essentialFiles) {
        const src = path.join(sourceCliDir, file);
        const dest = path.join(targetCliDir, file);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
            try {
                if (!isWindows) {
                    fs.symlinkSync(src, dest);
                } else {
                    fs.copyFileSync(src, dest);
                }
            } catch {
                try {
                    fs.copyFileSync(src, dest);
                } catch {
                    // ignore
                }
            }
        }
    }

    // Ensure bot profile has a strictly locked down settings.json denying dangerous tools
    const botSettingsFile = path.join(targetCliDir, "settings.json");
    const hardenedSettings = {
        permissions: {
            deny: ["command(*)", "edit_file(*)", "write_file(*)"],
            allow: []
        }
    };
    try {
        if (fs.existsSync(botSettingsFile) && fs.lstatSync(botSettingsFile).isSymbolicLink()) {
            fs.unlinkSync(botSettingsFile);
        }
        fs.writeFileSync(botSettingsFile, JSON.stringify(hardenedSettings, null, 2), "utf-8");
    } catch {
        // ignore
    }

    return botHome;
}

/**
 * Clean terminal ANSI color codes and extra whitespace.
 * @param {string} text
 * @returns {string}
 */
function cleanOutput(text) {
    if (!text) return "";
    // Strip ANSI codes
    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    return text.replace(ansiRegex, "").trim();
}

/**
 * Generate a response using agy CLI.
 *
 * @param {object} params
 * @param {string} params.prompt - Structured prompt
 * @param {AbortSignal} [params.abortSignal] - Signal to abort execution on manual override
 * @param {number} [params.timeout=45000] - Timeout in ms
 * @returns {Promise<string>}
 */
export function generateAiReply({ prompt, abortSignal, timeout = 45000 }) {
    return new Promise((resolve, reject) => {
        const agyBin = getAgyBinPath();

        // Windows CreateProcess lpCommandLine limit is 32,767 chars
        let safePrompt = prompt || "";
        if (process.platform === "win32" && safePrompt.length > 25000) {
            console.warn(`[AI_ENGINE] Prompt length (${safePrompt.length}) exceeds safe Windows CLI limit. Truncating context.`);
            const head = safePrompt.slice(0, 5000);
            const tail = safePrompt.slice(-18000);
            safePrompt = `${head}\n\n[...sebagian konteks dipotong demi batas buffer sistem...]\n\n${tail}`;
        }

        const args = [
            "-p", safePrompt,
            "--effort", "low",
            "--disable-slash-commands",
            "--dangerously-skip-permissions",
        ];

        // Safe execution directory: isolated inside temp directory to prevent agent from touching repo files
        const cwd = path.resolve(setting.tempDir || "temp");
        if (!fs.existsSync(cwd)) {
            fs.mkdirSync(cwd, { recursive: true });
        }

        const botHome = getIsolatedBotProfileDir();
        const isolatedEnv = {
            ...process.env,
            HOME: botHome,
            USERPROFILE: botHome,
        };

        const child = execFile(
            agyBin,
            args,
            {
                cwd,
                env: isolatedEnv,
                timeout,
                signal: abortSignal,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error) {
                    if (error.name === "AbortError" || abortSignal?.aborted) {
                        return reject(new Error("ABORTED_BY_MANUAL_OVERRIDE"));
                    }
                    console.error("[AI_ENGINE] agy execution error:", error.message, stderr);
                    return reject(error);
                }

                const cleaned = cleanOutput(stdout);
                resolve(cleaned);
            }
        );
    });
}

