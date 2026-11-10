/**
 * Comprehensive Offline Simulation Harness for Agentic-Bot
 */
import { initCommands, getCommand } from "./commands/_registry.js";
import { msgHandler } from "./handler.js";
import { Messages } from "./lib/Messages.js";
import db from "./lib/db.js";
import { getUser, isAiGlobalEnabled, getAiChatSettings, setAiGlobalConfig, setAiChatSettings } from "./lib/database.js";
import { buildAiPrompt } from "./lib/aiContextBuilder.js";
import { handleManualInterrupt } from "./lib/aiQueue.js";
import setting from "./setting.js";

async function runSimulation() {
    console.log("=================================================");
    console.log("🚀 STARTING AGENTIC-BOT OFFLINE SIMULATION SUITE");
    console.log("=================================================\n");

    const results = { passed: 0, failed: 0, total: 0 };
    function assert(desc, condition) {
        results.total++;
        if (condition) {
            results.passed++;
            console.log(`  ✅ [PASS] ${desc}`);
        } else {
            results.failed++;
            console.log(`  ❌ [FAIL] ${desc}`);
        }
    }

    // Configure test owner & disable spam delay for instant test execution
    const TEST_OWNER_NUM = "6281111111111";
    const TEST_USER_NUM = "6282222222222";
    const TEST_BOT_NUM = "6289999999999";
    setting.owner = [TEST_OWNER_NUM];
    setting.spamDelay = 0;

    // Mock WASocket
    const sentMessages = [];
    const presenceUpdates = [];
    const readMessagesList = [];

    const mockSock = {
        user: { id: `${TEST_BOT_NUM}:1@s.whatsapp.net` },
        async sendMessage(chat, content, options) {
            sentMessages.push({ chat, content, options, timestamp: Date.now() });
            return {
                key: {
                    id: "MOCK_MSG_" + Math.random().toString(36).substring(7),
                    remoteJid: chat,
                    fromMe: true
                }
            };
        },
        async relayMessage(chat, content, options) {
            sentMessages.push({ chat, content, options, timestamp: Date.now(), isRelay: true });
            return {
                key: {
                    id: options?.messageId || "MOCK_RELAY_" + Math.random().toString(36).substring(7),
                    remoteJid: chat,
                    fromMe: true
                }
            };
        },
        async readMessages(keys) {
            readMessagesList.push(keys);
        },
        async sendPresenceUpdate(type, chat) {
            presenceUpdates.push({ type, chat });
        },
        async fetchBlocklist() {
            return [];
        },
        async groupMetadata(chat) {
            return {
                id: chat,
                subject: "Test Group",
                participants: [
                    { id: `${TEST_OWNER_NUM}@s.whatsapp.net`, admin: "admin" },
                    { id: `${TEST_USER_NUM}@s.whatsapp.net`, admin: null },
                    { id: `${TEST_BOT_NUM}@s.whatsapp.net`, admin: "admin" }
                ]
            };
        }
    };

    function createMockUpsert(text, senderNum, isFromMe = false, isGroup = false, extra = {}) {
        const remoteJid = isGroup ? "120363041234567890@g.us" : `${senderNum}@s.whatsapp.net`;
        const senderJid = `${senderNum}@s.whatsapp.net`;
        const stanzaId = "SIM_" + Math.random().toString(36).substring(7);

        const rawMsg = {
            key: {
                remoteJid,
                fromMe: isFromMe,
                id: stanzaId,
                participant: isGroup ? senderJid : undefined
            },
            message: {
                conversation: text
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: isFromMe ? "OwnerBot" : `User_${senderNum.slice(-4)}`,
            ...extra
        };

        const upsert = {
            type: "notify",
            messages: [rawMsg]
        };

        const message = Messages(upsert, mockSock);
        return { upsert, message };
    }

    // Helper to dispatch mock messages with slight delay to clear event loop ticks
    async function dispatchMessage(text, senderNum, isFromMe = false, isGroup = false, extra = {}) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const { upsert, message } = createMockUpsert(text, senderNum, isFromMe, isGroup, extra);
        await msgHandler(upsert, mockSock, message);
        return { upsert, message };
    }

    // ── Test 1: Command Registry Loading ─────────────────────────────────
    console.log("📦 1. Testing Command Registry...");
    await initCommands();
    const pingCmd = getCommand("ping");
    const aiCmd = getCommand("ai");
    const htmlCmd = getCommand("html");

    assert("Command 'ping' is registered", !!pingCmd);
    assert("Command 'ai' is registered with ownerOnly flag", !!aiCmd && aiCmd.ownerOnly === true);
    assert("Command 'html' is registered", !!htmlCmd);

    // ── Test 2: Public Command Execution (!ping) ─────────────────────────
    console.log("\n🏓 2. Testing !ping Command & Auto-Registration...");
    sentMessages.length = 0;
    await dispatchMessage("!ping", TEST_USER_NUM);

    assert("!ping sent response", sentMessages.length > 0);
    const lastPingReply = sentMessages[sentMessages.length - 1]?.content?.text || "";
    assert("Response contains 'PONG' and latency", lastPingReply.includes("PONG") && lastPingReply.includes("Response"));

    const dbUser = getUser(`${TEST_USER_NUM}@s.whatsapp.net`);
    assert("User was auto-registered in SQLite", dbUser && dbUser.registered === true);

    // ── Test 3: Permission Guard (Non-owner calling !ai) ─────────────────
    console.log("\n🔒 3. Testing Permission Guard (!ai as regular user)...");
    sentMessages.length = 0;
    await dispatchMessage("!ai status", TEST_USER_NUM);

    const guardReply = sentMessages[sentMessages.length - 1]?.content?.text || "";
    assert("Permission denied for non-owner on !ai", guardReply.includes("restricted to the System Owner"));

    // ── Test 4: Owner Command Execution (!ai status) ─────────────────────
    console.log("\n👑 4. Testing Owner-Only Execution (!ai status & on/off)...");
    sentMessages.length = 0;
    await dispatchMessage("!ai status", TEST_OWNER_NUM);

    const ownerReply = sentMessages[sentMessages.length - 1]?.content?.text || "";
    assert("Owner allowed to run !ai status", ownerReply.includes("AI USERBOT STATUS"));

    // Toggle AI Global switch
    await dispatchMessage("!ai on", TEST_OWNER_NUM);
    assert("Master switch activated in DB", isAiGlobalEnabled() === true);

    // ── Test 5: Rich HTML UI Engine & Validator ──────────────────────────
    console.log("\n🎨 5. Testing HTML Validation & UI Engine...");
    const invalidHtml1 = "<div class='test'>Unclosed div";
    sentMessages.length = 0;
    await dispatchMessage(`!html ${invalidHtml1}`, TEST_OWNER_NUM);
    const replyInv = sentMessages[sentMessages.length - 1]?.content?.text || "";
    assert("!html detects invalid HTML and replies with error", replyInv.includes("KODE HTML TIDAK VALID"));

    const validHtml = "<div class='ui-page'><div class='ui-header'><h1 class='ui-header-title'>Dashboard</h1></div><p>System OK</p></div>";
    sentMessages.length = 0;
    await dispatchMessage(`!html -k ${validHtml}`, TEST_OWNER_NUM);
    const htmlSend = sentMessages.find(m => !!m.content?.botForwardedMessage?.message?.richResponseMessage);
    assert("!html sent richResponseMessage webview payload", !!htmlSend);

    // ── Test 6: Sliding-Window Context & Prompt Builder ─────────────────
    console.log("\n🧠 6. Testing Sliding-Window History & Prompt Builder...");
    const chatJid = `${TEST_USER_NUM}@s.whatsapp.net`;
    // Simulate back-and-forth chat in SQLite
    await dispatchMessage("Halo apa kabar?", TEST_USER_NUM);
    await dispatchMessage("Halo juga, saya baik! Ada yang bisa dibantu?", TEST_BOT_NUM, true);
    const { message: mh3 } = await dispatchMessage("Bisa tolong buatkan jadwal rapat?", TEST_USER_NUM);

    const promptObj = await buildAiPrompt({
        chatJid,
        chatName: "User 2222",
        isGroup: false,
        ownerName: "Owner",
        triggerMessage: mh3,
        triggerText: "Bisa tolong buatkan jadwal rapat?"
    });

    assert("Prompt generated successfully", typeof promptObj.prompt === "string" && promptObj.prompt.length > 0);
    assert("Prompt contains sliding window thread indices (#1, #2)", promptObj.prompt.includes("#1") && promptObj.prompt.includes("#2"));
    assert("Prompt preserves conversation context", promptObj.prompt.includes("Halo apa kabar") && promptObj.prompt.includes("jadwal rapat"));

    // ── Test 7: Manual Override (Loop Breaker) ───────────────────────────
    console.log("\n🛑 7. Testing Manual Interrupt (Loop Breaker)...");
    let interruptThrew = false;
    try {
        handleManualInterrupt(chatJid);
    } catch (e) {
        interruptThrew = true;
    }
    assert("handleManualInterrupt cleans up gracefully without errors", !interruptThrew);

    // ── Test 8: Antigravity CLI Bridge (agy) ──────────────────────────────
    console.log("\n🤖 8. Testing Antigravity CLI Bridge (agy)...");
    const { generateAiReply } = await import("./services/aiEngine.js");
    let agyReply = "";
    try {
        agyReply = await generateAiReply({
            prompt: "Jawablah dengan 1 kata saja: READY",
            timeout: 25000
        });
    } catch (e) {
        console.error("agy bridge error:", e.message);
    }
    assert("Antigravity CLI (agy) responded correctly", typeof agyReply === "string" && agyReply.toUpperCase().includes("READY"));

    // ── Cleanup Test Artifacts ──────────────────────────────────────────
    try {
        db.prepare("DELETE FROM users WHERE id LIKE '6281111111111%' OR id LIKE '6282222222222%'").run();
        db.prepare("DELETE FROM chat_messages WHERE id LIKE 'SIM_%'").run();
        db.prepare("INSERT INTO ai_global_config (key, value) VALUES ('enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    } catch {}

    // ── Simulation Summary ───────────────────────────────────────────────
    console.log("\n=================================================");
    console.log(`📊 SIMULATION COMPLETE: ${results.passed}/${results.total} checks PASSED (${results.failed} failed)`);
    console.log("=================================================");

    if (results.failed > 0) {
        process.exit(1);
    }
}

runSimulation().catch(err => {
    console.error("Simulation crashed with error:", err);
    process.exit(1);
});
