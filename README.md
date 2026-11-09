# Agentic-Bot

An autonomous, agentic WhatsApp userbot and multi-instance bot engine built with [Baileys](https://github.com/WhiskeySockets/Baileys), Node.js (ES Modules), SQLite (WAL mode), and Google Antigravity (`agy`) CLI.

Run multiple bot accounts concurrently from a single codebase, utilize persistent sliding-window context and thread reconstruction, simulate human conversation via an agentic userbot, render native interactive in-app HTML webviews, and execute commands with zero downtime.

---

## Highlights

- **Autonomous Agentic Userbot**: Acts directly on behalf of the account owner via the Google Antigravity (`agy`) CLI, supporting non-interactive reasoning and agentic workflows.
- **Sliding-Window Context Reconstruction**: Maintains a 15-message chronological context with local thread numbering (`#1`, `#2 [Reply #1]`), out-of-window quoted message recovery via SQLite, and zero-download media tagging.
- **Debounce & Mutex Concurrency Queue**: Aggregates rapid successive chat bubbles into single prompts via a 3.5s debounce buffer, serializes inferencing per chat via a FIFO mutex queue, and simulates WhatsApp typing indicators (`composing` / `paused`).
- **Instant Manual Override (Loop Breaker)**: Automatically cancels pending debounce buffers and aborts active AI execution if the account owner sends a manual chat message.
- **Multi-Instance Concurrency (PM2)**: Run dozens of bot numbers simultaneously with process isolation, independent session stores, and atomic SQLite message claim deduplication.
- **SQLite with WAL Mode**: Embedded zero-config database using `better-sqlite3` with Write-Ahead Logging for high-throughput concurrent reads and writes, paired with automatic 48-hour message pruning.
- **Interactive HTML UI Engine (Webview)**: Send native in-app HTML5/CSS3 graphical interfaces (cards, dashboards, pseudo-buttons, client-side tabs) via WhatsApp's `richResponseMessage` protocol.
- **Zero-Downtime Hot-Reload**: Live-edit command files and the core message pipeline without disconnecting the WhatsApp socket.
- **Deterministic Identity Resolution**: Fully resolves WhatsApp's Linked Device ID (LID) privacy mode and multi-device suffixes into canonical phone number JIDs.
- **Declarative Middleware**: Protect commands with simple declarative flags (`groupOnly`, `adminOnly`, `botAdminRequired`, `ownerOnly`, `privateOnly`, `silentDrop`).
- **Headless Pairing Code**: Authenticate on headless VPS environments without QR code scanning using 8-character phone pairing codes.
- **Call Protection**: Automatically rejects unsolicited voice/video calls with progressive warnings and automatic auto-ban.

---

## Documentation Suite

Comprehensive technical guides are available in the [`docs/`](docs/README.md) directory:

| Guide | Description |
| :--- | :--- |
| [**Agentic AI & Infrastructure**](docs/AGENTIC_INFRASTRUCTURE.md) | End-to-end review of the AI Userbot subsystem, message ingestion, context reconstruction, debounce mutex queue, and Linux VPS deployment. |
| [**Architecture & Pipeline**](docs/ARCHITECTURE.md) | 13-stage message pipeline, PM2 multi-instance model, hot-reload internals, and LID/PN identity resolution. |
| [**Command & UI Development**](docs/COMMAND_DEVELOPMENT.md) | Command anatomy, declarative permission flags, Interactive HTML UI Engine (`uiEngine`), reply handlers, and auto-detection. |
| [**Database & Storage**](docs/DATABASE.md) | Complete SQLite schema (including `chat_messages` and `ai_*` tables), WAL configuration, canonical JID rules, and maintenance routines. |
| [**Configuration & Deployment**](docs/CONFIGURATION_DEPLOYMENT.md) | Environment variables, PM2 setup (`ecosystem.config.cjs`), QR vs. Pairing Code, and automated VACUUM cleanup. |
| [**Changelog**](docs/CHANGELOG.md) | Structured SemVer release notes documenting features, fixes, and engine upgrades. |

---

## Quick Start

### 1. Requirements
- **Node.js** v18+ (v20 LTS recommended)
- **Google Antigravity (`agy`) CLI** (installed and available in system PATH or configured via `AGY_BIN_PATH`)
- **C++ Build Tools** (for `better-sqlite3` native compilation):
  - *Linux*: `sudo apt install -y build-essential python3`
  - *Windows*: Visual Studio Build Tools (Desktop C++)

### 2. Installation
```bash
git clone https://github.com/Tederby/agentic-bot.git
cd agentic-bot
npm install
```

### 3. Configuration
```bash
cp .env.example .env
# Configure your OWNER_NUMBER, PREFIXES, AGY_BIN_PATH, and bot settings
```

### 4. Running the Bot

#### Mode A: Single Bot (Terminal QR Code)
```bash
npm start
# Scan the QR code displayed in your terminal with WhatsApp
```

#### Mode B: Multi-Bot / Production (PM2)
Edit `ecosystem.config.cjs` to define your bot instances, then start them:
```bash
npm run pm2

# Check status and logs
pm2 status
pm2 logs bot1
```

#### Mode C: Headless Pairing Code (No QR)
Set `PAIRING_NUMBER` in `.env` or `ecosystem.config.cjs`:
```javascript
PAIRING_NUMBER: "6281234567890" // Start with country code
```
Start the bot, copy the 8-character pairing code from the logs, and enter it under **Linked Devices** > **Link with phone number instead**.

---

## Agentic AI Userbot Usage

Control the AI userbot companion using the master command:

```text
!ai status                    # View global switch, chat switch, mode, and ignore list
!ai on / !ai off              # Master switch enabling/disabling AI globally
!ai chat on / !ai chat off    # Enable/disable AI in current DM or group
!ai mode <trigger|command>    # Set sensitivity (trigger responds to mentions/replies/DMs)
!ai ignore add @user          # Ignore specific members in a group
!ai ignore del @user          # Unignore a member in a group
!ai ignore list               # View current group ignore list
```

---

## Project Structure

```
agentic-bot/
├── commands/                   # Auto-loaded command modules
│   ├── _registry.js            # Dynamic loader & reply handler registry
│   ├── ai.js                   # Master AI Userbot control command
│   ├── ping.js                 # Minimal latency check command
│   └── html.js                 # Interactive HTML webview renderer command
├── docs/                       # Technical documentation suite
│   ├── README.md               # Documentation index
│   ├── AGENTIC_INFRASTRUCTURE.md # AI Userbot architecture & VPS deployment guide
│   ├── ARCHITECTURE.md         # Pipeline & concurrency architecture
│   ├── COMMAND_DEVELOPMENT.md  # Command & UI development guide
│   ├── DATABASE.md             # SQLite schema & canonical JID reference
│   ├── CONFIGURATION_DEPLOYMENT.md # PM2 & deployment reference
│   └── CHANGELOG.md            # Structured SemVer changelog
├── lib/                        # Core engine modules
│   ├── db.js                   # SQLite connection & WAL pragmas
│   ├── database.js             # User/group CRUD, canonical ID, chat history & AI settings
│   ├── messageLogger.js        # Chat history ingestion to chat_messages
│   ├── aiContextBuilder.js      # Sliding-window context & thread tagging builder
│   ├── aiQueue.js              # Debounce buffer, FIFO mutex queue, manual interrupt
│   ├── uiEngine.js             # Native HTML webview renderer & templates
│   ├── Messages.js             # Baileys message wrapper & serializer
│   ├── commandParser.js        # Prefix & argument parsing
│   ├── contextBuilder.js       # Context resolution (sender, admin, group)
│   ├── jidHelper.js            # JID normalization & extraction helpers
│   ├── middleware.js           # Declarative permission checks
│   ├── autoDetect.js           # Pattern & URL matching registry
│   ├── logger.js               # Centralized formatted terminal logging
│   └── utils.js                # Utilities & spam filter
├── patches/
│   └── baileys+7.0.0-rc13.patch # tcToken protocol fix via patch-package
├── services/
│   ├── aiEngine.js             # Antigravity (agy) CLI execution bridge
│   └── cleanup.js              # Background temp file, 48h chat purge & VACUUM
├── index.js                    # Entry point, socket & connection lifecycle
├── handler.js                  # 13-stage message processing pipeline
├── setting.js                  # Consolidated configuration
└── ecosystem.config.cjs        # PM2 multi-instance cluster definition
```

---

## License

[MIT](LICENSE)
