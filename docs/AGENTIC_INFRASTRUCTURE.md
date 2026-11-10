# Agentic-Bot: Infrastructure & Feature Architecture

This document provides a comprehensive technical review of the architecture, subsystems, and features powering **`agentic-bot`** (`wa-bot-engine`). It details both the foundational WhatsApp engine and the integrated Agentic AI Userbot subsystem driven by Google Antigravity (`agy`).

---

## 1. System Overview & Target Environment

> [!IMPORTANT]
> **PRODUCTION TARGET: LINUX OS (STRONGLY RECOMMENDED)**  
> `agentic-bot` is architected from the ground up for **Linux (Ubuntu / Debian VPS & Dedicated Servers)**. While Windows is supported as a local development convenience, running 24/7 autonomous production instances on Linux is strongly recommended due to:
> 1. **POSIX Process Execution**: Seamless non-interactive child process spawning of the `agy` CLI without shell quoting or Windows cmd/PowerShell encoding artifacts.
> 2. **Persistent Daemonization**: Zero-overhead 24/7 execution via PM2 with automatic resurrection on server reboot.
> 3. **High-Throughput Concurrent SQLite WAL**: Linux kernel file descriptor handling and shared memory (`.db-shm`) deliver optimal concurrent reads and writes.
> 4. **Network Stack Stability**: Robust long-lived TCP/WebSocket connections preventing NAT drops.

`agentic-bot` is engineered as a hybrid platform:
1. **Multi-Instance WhatsApp Bot Engine**: A modular, multi-process runtime built on [Baileys](https://github.com/WhiskeySockets/Baileys) and SQLite WAL mode.
2. **Autonomous Agentic Userbot**: An AI companion acting directly on behalf of the account owner, parsing natural conversation context, preventing spam/loops, and executing agentic workflows via the Antigravity (`agy`) CLI on Linux VPS.

```mermaid
flowchart TD
    subgraph Ingress [1. Message Ingress]
        A["Baileys Socket (messages.upsert)"] --> B["Messages() Extended Wrapper"]
        B --> C["messageLogger.js (SQLite Ingestion)"]
    end

    subgraph Core_Pipeline [2. Core Pipeline (handler.js)]
        C --> D{"Guard & Offline Replay Check"}
        D --> E["Context Builder (LID ↔ PN Resolution)"]
        E --> F{"Is Command (!prefix)?"}
        F -- Yes --> G["Command Registry & Permission Middleware"]
        F -- No --> H{"Is fromMe (Manual Message)?"}
        H -- Yes --> I["Manual Interrupt (Abort AI Queue)"]
        H -- No --> J{"AI Trigger Resolver"}
    end

    subgraph Agentic_AI [3. Agentic Userbot Subsystem]
        J -- Triggered --> K["aiQueue.js (3.5s Debounce Buffer)"]
        K --> L["FIFO Mutex Queue per-chat"]
        L --> M["sendPresenceUpdate('composing')"]
        M --> N["aiContextBuilder.js (15 History + Thread Tagging)"]
        N --> O["services/aiEngine.js (agy CLI Bridge)"]
        O --> P["sock.sendMessage()"]
        P --> Q["sendPresenceUpdate('paused')"]
    end
```

---

## 2. Core Infrastructure Layers

### A. WhatsApp Socket & Lifecycle Hardening ([`index.js`](../index.js))
* **Session Isolation**: Each bot instance maintains its credentials in `sessions/<botId>/` using Baileys' `useMultiFileAuthState`.
* **Anti-Collision Cleanup**: Reconnections forcefully tear down old socket event listeners and WebSocket pipes (`removeAllListeners`, `ws.close`, `end`), preventing duplicate handshake collisions on identical device keys.
* **Corrupted Session Guard (`500 badSession`)**: Allows up to 2 transient retries with exponential backoff before safely purging corrupt session tokens and suspending execution.
* **Immediate 401 Session Purge**: If credentials expire or are revoked on WhatsApp Web (`401 loggedOut`), the directory is automatically wiped and the process exits cleanly.
* **Dual Connection Modes**: Supports interactive terminal QR generation or headless Pairing Code (`PAIRING_NUMBER`) for VPS deployment.

### B. Shared Concurrency Storage & Database ([`lib/db.js`](../lib/db.js) & [`lib/database.js`](../lib/database.js))
The bot utilizes `better-sqlite3` with strict performance pragmas:
* `journal_mode = WAL` (Write-Ahead Logging): Allows concurrent readers and one writer without blocking.
* `busy_timeout = 5000`: Queues write locks for up to 5 seconds across PM2 worker processes.
* `synchronous = NORMAL`: Minimizes I/O disk wear while preserving ACID safety.

#### Data Schema Overview:
| Table | Scope | Purpose |
|:---|:---|:---|
| `chat_messages` | Engine / AI | Stores raw and serialized messages for sliding-window context retrieval. |
| `ai_global_config` | AI Subsystem | Master switch (`enabled`) and default AI persona text. |
| `ai_chat_settings` | AI Subsystem | Per-chat switches, sensitivity mode (`trigger` vs `command`), custom personas. |
| `ai_group_ignores` | AI Subsystem | Blacklist of users whose messages are ignored by AI in specific groups. |
| `identity_map` | Identity | Passive mapping between WhatsApp Privacy LIDs (`@lid`) and Phone Number JIDs (`@s.whatsapp.net`). |
| `message_claims` | Multi-Bot | Distributed lock ensuring only the highest-priority bot responds in a group. |
| `bot_registry` | Multi-Bot | Heartbeat tracking for active bot processes in multi-instance setups. |
| `users` & `groups` | Bot Core | User registration, permissions, and group configuration records. |

### C. Message Ingestion Pipeline ([`lib/messageLogger.js`](../lib/messageLogger.js))
Because Baileys does not persistently store chat history, `agentic-bot` implements an asynchronous ingestion stage before command parsing:
* Records every message passing through the handler pipeline (both incoming and user-sent `fromMe`).
* Normalizes sender JIDs to canonical Phone Number format (`@s.whatsapp.net`).
* Extracts media types (`image`, `video`, `sticker`, `audio`, `document`) and captions without downloading full binary streams.
* Indexes `chat_jid`, `timestamp DESC`, and `quoted_id` for microsecond query performance.

### D. Automated Maintenance & Pruning ([`services/cleanup.js`](../services/cleanup.js))
Runs periodic background timers to keep system resource usage lean:
* **Chat History Pruning**: Deletes records in `chat_messages` older than 48 hours.
* **Temp Directory Purging**: Purges temporary files older than `setting.fileExpiry` (30 minutes).
* **Claims Cleanup**: Removes expired message claims older than 5 minutes.
* **SQLite VACUUM**: Defragments database pages every 30 minutes to reclaim freed disk space.

---

## 3. Agentic AI Userbot Features

### A. Context Reconstruction & Thread Tagging ([`lib/aiContextBuilder.js`](../lib/aiContextBuilder.js))
WhatsApp group chats are non-linear (multiple conversations occur concurrently via replies). The context builder solves context dilution and disorientation through:
1. **15-Message Chronological Sliding Window**: Extracts the most recent 15 messages for the active chat.
2. **Local Reference Indexing**: Assigns sequential IDs (`#1`, `#2`, ..., `#15`).
3. **Thread Tagging**: If message `#4` quotes message `#1`, it is serialized as `#4 | 17:06 | User [Reply #1]: "Text"`.
4. **Enhanced Out-of-Window Reference Recovery & Ancestor Chaining**:
   - If a quoted message is found in SQLite outside the 15-message window, it traverses up to 2 parent hops (`#Ref-2`, `#Ref-1`, `#Ref`) to provide a complete conversation thread.
   - **In-Memory Protobuf Fallback**: If the quoted message is not in SQLite (e.g. older than the 48-hour pruning cycle or sent before the bot was initialized), the builder falls back directly to the in-memory `triggerMessage.quoted` payload delivered by WhatsApp, ensuring quote context is never lost.
5. **Debounce Quote Preservation**: Scans all accumulated bubbles in a debounce window so that replying to a message followed by quick follow-up texts retains the reply target.
6. **Zero-Download Media Representations**: Avoids latency and bandwidth bottlenecks by serializing media into metadata tags (`[Mengirim foto: "caption"]`, `[Mengirim stiker]`).

### B. Per-Chat Debounce & FIFO Mutex Queue ([`lib/aiQueue.js`](../lib/aiQueue.js))
Human WhatsApp users often send multiple short messages in rapid succession ("P", "Bro", "Where are you?").
* **Debounce Buffer (3.5s)**: Accumulates consecutive messages into a single aggregated prompt. In groups, debounce buffers are strictly isolated per sender (`(chatJid + sender)`), ensuring casual cross-talk from other participants does not hijack or extend active debounce sessions.
* **Smart Quoted Reply Targeting**: In DMs, replies are sent unquoted (`quoted: undefined`) for natural human-like flow. In groups, replies target the initial triggering message (`firstTriggerMessage`), preventing replies from quoting irrelevant trailing messages (e.g. "p" or "wkwk").
* **FIFO Mutex Lock**: Ensures only one `agy` inference runs per chat at any time. Triggers from distinct users in the same group queue cleanly in memory without race conditions or swallowed messages.
* **WhatsApp Presence Simulation**: Automatically triggers `sock.sendPresenceUpdate('composing', chatJid)` with an 8-second recurring heartbeat during processing, resetting to `'paused'` upon completion.
* **Instant Bot Response Persistence**: Immediately logs the bot's own response into `chat_messages` upon dispatch for instant context synchronization.
* **Manual Interrupt (Override)**: If the account owner types a message manually (`fromMe: true`) in that chat, any pending debounce timer is cleared and any active `agy` child process is immediately terminated via `AbortController`.

### C. Antigravity CLI Bridge ([`services/aiEngine.js`](../services/aiEngine.js))
Connects the bot to the local Google Antigravity binary:
* **Execution Parameters**:
  ```bash
  agy -p "<prompt>" --effort low --disable-slash-commands --dangerously-skip-permissions
  ```
* **Cross-Platform Compatibility**:
  - **Linux VPS (Production)**: Uses `agy` directly from system PATH or the `AGY_BIN_PATH` environment variable.
  - **Windows (Development)**: Dynamically resolves `agy.exe` via `%USERPROFILE%\.gemini\bin\agy.exe`.
* **CLI Buffer Protection**: Protects against Windows `CreateProcess` 32,767 character limits by safely truncating oversized context prompts (>25KB).
* **Isolated Sandbox Directory**: The CLI executes inside `temp/`, preventing accidental modification or indexing of bot source code during casual chat inference.

### D. Userbot Command Master ([`commands/ai.js`](../commands/ai.js))
Control interface restricted to the bot owner (`ownerOnly: true`):
* `!ai status`: Inspects global status, chat switch, active mode, persona, and ignored members.
* `!ai on` / `!ai off`: Master switch enabling/disabling AI functionality globally.
* `!ai chat on` / `!ai chat off`: Enables/disables AI specifically in the current DM or group.
* `!ai mode <trigger|command>`: Sets sensitivity (`trigger` responds to tags/replies/DMs; `command` only responds to explicit keywords).
* `!ai persona [show|set <prompt>|reset|global <prompt>]`: Configures and resets per-chat or global AI personas.
* `!ai ignore <add|del|list> @user`: Manages the ignore list for specific members in a group.

---

## 4. Built-in Security & Utility Features

### A. WhatsApp Identity Resolution (LID vs. PN) ([`lib/jidHelper.js`](../lib/jidHelper.js))
Modern WhatsApp uses Privacy Linked Device IDs (`@lid`) in privacy-oriented groups. The engine enforces the **Canonical ID Rule**:
* Raw JIDs are normalized using `jidNormalizedUser()` (stripping `:device` suffixes).
* LIDs are converted to phone numbers via `identity_map` lookups (`resolveUserId()`).
* Commands use `extractTarget()` to safely extract canonical numbers from mentions, quotes, or manual arguments.

### B. Call Protection Subsystem ([`index.js`](../index.js))
Prevents unsolicited incoming WhatsApp voice/video calls from hanging the socket:
* Immediate automated call rejection via `sock.rejectCall()`.
* Deduplication using a 1-hour `processedCalls` map.
* Progressive warning notices (1st–3rd call) followed by an automated global ban (4th call).
* Numbers listed in `setting.owner` are exempt from bans.

### C. Native In-App Webview Engine ([`lib/uiEngine.js`](../lib/uiEngine.js))
Renders full HTML5/CSS3 interfaces inside WhatsApp chat threads utilizing WhatsApp's native `richResponseMessage` protocol (`GenAIaeacdsnwHtmlPrimitive`). Provides rich interactive cards without directing users to external web browsers.

---

## 5. Deployment Guide (Linux VPS)

### 1. Prerequisites
```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Antigravity CLI Verification
Ensure the `agy` binary is installed and operational on your Linux VPS:
```bash
agy --version
agy -p "Say hello" --effort low
```
*If `agy` is installed in a custom directory (e.g. `~/.gemini/bin/agy`), set `AGY_BIN_PATH=/root/.gemini/bin/agy` in `.env`.*

### 3. Application Setup
```bash
git clone <repo_url> agentic-bot
cd agentic-bot
npm install
cp .env.example .env
nano .env
```

### 4. Running with PM2
```bash
# Start cluster
npm run pm2

# Check logs for Pairing Code or QR code
pm2 logs --lines 50

# Ensure auto-restart on system reboot
pm2 save
pm2 startup
```

