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
        const localAgy = "C:\\Users\\user\\.gemini\\bin\\agy.exe";
        if (fs.existsSync(localAgy)) {
            return localAgy;
        }
    }
    return "agy";
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
        const args = [
            "-p", prompt,
            "--effort", "low",
            "--disable-slash-commands",
            "--dangerously-skip-permissions",
        ];

        // Safe execution directory: isolated inside temp directory to prevent agent from touching repo files
        const cwd = path.resolve(setting.tempDir || "temp");
        if (!fs.existsSync(cwd)) {
            fs.mkdirSync(cwd, { recursive: true });
        }

        const child = execFile(
            agyBin,
            args,
            {
                cwd,
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

