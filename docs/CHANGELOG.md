# Changelog

All notable changes to **WA-Bot-Engine** are documented in this file. This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.3.1] — 2026-11-09

### Added
- **In-Memory Quoted Protobuf Fallback (`lib/aiContextBuilder.js`)**: Implemented graceful in-memory recovery using `triggerMessage.quoted` when a quoted message is missing from SQLite (e.g. older than 48h or from previous bot sessions).
- **Multi-Level Ancestor Thread Chaining (`lib/aiContextBuilder.js`)**: Added recursive 2-hop parent traversal (`#Ref-2`, `#Ref-1`, `#Ref`) to reconstruct conversation threads when replying to older messages.
- **Debounce Context Preservation (`lib/aiQueue.js`)**: Scans all chat bubbles in the 3.5s debounce buffer to preserve quoted message metadata even when follow-up messages lack quotes.
- **Continuous Typing Presence Heartbeat (`lib/aiQueue.js`)**: Added an 8-second interval renewing WhatsApp `composing` status during long AI inferences.
- **Instant Bot Response Ingestion (`lib/aiQueue.js`)**: Saves the bot's own AI reply directly into `chat_messages` upon sending to ensure immediate chronological synchronization.
- **Persona Management Subcommand (`commands/ai.js`)**: Added `!ai persona [show|set <prompt>|reset|global <prompt>]` for per-chat and global persona customization.
- **Timestamp Index on `chat_messages` (`lib/db.js`)**: Added `idx_chat_messages_timestamp` to optimize the 48-hour periodic message pruning query.

### Fixed
- **Multi-Bot Claim AI Mention Race Condition (`handler.js`)**: Ensured group messages directly mentioning or replying to a specific bot bypass general multi-bot claiming so targeted AI responses are not swallowed by unmentioned bots.
- **Batch Message Ingestion (`index.js`)**: Iterates through all elements in `upsert.messages` instead of processing only `messages[0]`, preventing missed messages during batch delivery.
- **Dynamic Cross-Platform Agy Path Resolution (`services/aiEngine.js`)**: Resolves `%USERPROFILE%\.gemini\bin\agy.exe` dynamically on Windows instead of relying on a hardcoded username.
- **CLI Command Length Overflow Protection (`services/aiEngine.js`)**: Added guard truncating prompts exceeding 25,000 characters to prevent Windows `CreateProcess` 32KB buffer limits.
- **Quoted Sender LID Resolution (`lib/Messages.js`)**: Evaluates `m.quoted.key.fromMe` using canonical JID matching via `resolveUserId()` to prevent LID false-negatives.
- **Queue Memory Leak (`lib/aiQueue.js`)**: Prunes finished, empty chat keys from `chatQueues` Map.

---

## [1.3.0] — 2026-11-09

### Added
- **Agentic AI Userbot Subsystem**: Integrated Google Antigravity (`agy`) CLI bridge (`services/aiEngine.js`) to power autonomous userbot responses on Linux VPS and Windows environments.
- **Persistent Message Ingestion Pipeline (`lib/messageLogger.js`)**: Passively records incoming and outgoing (`fromMe: true`) messages into the `chat_messages` SQLite table with compound index lookups.
- **Sliding-Window Context Reconstruction (`lib/aiContextBuilder.js`)**: Implemented 15-message chronological sliding window with local thread tagging (`#1`, `#2 [Reply #1]`), zero-download media representations, and out-of-window quoted message recovery via SQLite lookups.
- **Per-Chat Debounce & FIFO Mutex Queue (`lib/aiQueue.js`)**: Added a 3.5-second debounce buffer to aggregate rapid successive chat bubbles, a per-chat concurrency mutex queue, native WhatsApp typing simulation (`composing`/`paused`), and instantaneous manual interrupts via `AbortController` when the account owner types manually.
- **Master Userbot Command (`commands/ai.js`)**: Owner-only command interface supporting `!ai status`, `!ai on/off`, `!ai chat on/off`, `!ai mode <trigger|command>`, and `!ai ignore <add|del|list> @user`.
- **Database Schemas for AI**: Added `chat_messages`, `ai_global_config`, `ai_chat_settings`, and `ai_group_ignores` in `lib/db.js` with helper methods in `lib/database.js`.
- **Automated Message Retention Pruning**: Integrated automatic 48-hour message purging in `services/cleanup.js`.
- **Comprehensive Infrastructure Review (`docs/AGENTIC_INFRASTRUCTURE.md`)**: Full technical documentation detailing the architecture, data flow, queue mechanics, and Linux VPS deployment.

### Fixed
- **Mention Array Verification (`lib/Messages.js`)**: Fixed bug where `m.mentionMe` only inspected `mentionedJid[0]` without JID normalization; now properly evaluates the entire array using `jidNormalizedUser()`.

---

## [1.2.0] — 2026-11-09

### Added
- **Centralized POSIX CLI Flag Parser (`lib/flagParser.js`)**: Standalone engine supporting short flags (`-f`), long flags (`--flag`), clustered flags (`-tu`), parameter values (`-w 5`), positional argument isolation (`cleanArgs`), and freeform text flag extraction (`extractFlagsFromText`).
- **Pipeline Flag Parsing Stage**: Integrated declarative flag parsing directly into Stage 8 of `handler.js`, passing structured `flags` and `cleanArgs` to command handlers.
- **Group Participant Event Handler (`lib/events/group-participants.js`)**: Listens to `group-participants.update` to automatically invalidate group metadata cache upon membership changes and support multi-bot greetings.
- **Database Maintenance & Repair (`repairDatabase`)**: Added comprehensive SQLite repair function in `lib/database.js` performing integrity checks, orphan ban cleanup, and stale claim/registry pruning.
- **Shared Formatting Utilities (`lib/utils.js`)**: Added `ITEMS_PER_PAGE`, `generatePaginator()`, and `formatUptime()` helpers.
- **Webview Specification Suite (`docs/WEBVIEW_PAYLOAD.md`)**: Comprehensive documentation covering protobuf stanza architecture, 1350KB payload ceilings, and empirical sandbox constraints.

### Fixed
- **Socket Anti-Collision & Reconnection**: Explicitly removes WebSocket listeners and terminates old socket instances prior to reconnecting in `index.js`, eliminating dual-socket auth collisions on identical device keys.
- **Corrupted Session Handling (500 badSession)**: Implemented 2-retry threshold before automatically purging corrupted session folders and safely suspending.
- **Immediate 401 Session Purge**: Replaced endless reconnect loops on `401 Unauthorized` / `loggedOut` with immediate session wipe and clean suspension.
- **Call Spam Protection**: Extended deduplication TTL from 60 seconds to 1 hour (3,600,000 ms) in `index.js`.
- **Reply Handler Ownership**: Added `allowAnyUser` check to reply handlers in `handler.js`.

### Changed
- **Compact Standardized Logging (`lib/logger.js`)**: Overhauled console logger to single-line format with Chalk colors, status emojis, and timestamp tags.
- **Standardized Output Typography**: Updated `commands/ping.js` and `commands/html.js` to 24-character divider lines (`────────────────────────`), bold uppercase headers, and diamond bullets (`⋄`).
- **Command Flag Support in `!html`**: Added `--keep` (`-k`) flag support to disable 2-minute webview auto-deletion.
- **Socket Timeouts**: Configured 10s keep-alive interval and 60s timeout thresholds to prevent VPS NAT router drops.

---

## [1.1.0] — 2026-09-03

### Added
- **Interactive HTML UI Engine**: Introduced [`lib/uiEngine.js`](../lib/uiEngine.js) for rendering sandboxed HTML, CSS, and client-side JavaScript inside WhatsApp using the native `richResponseMessage` protocol.
- **Example `!html` Command**: Demonstrates interactive webview rendering, responsive styling, client-side pseudo-buttons via hash routing, and 2-minute auto-deletion lifecycle.
- **Canonical JID Resolution (`toCanonicalUserId`)**: Added deterministic normalization across all user and group ban database queries in [`lib/database.js`](../lib/database.js), preventing LID bypass vulnerabilities.
- **Context Sender Normalization**: Automatically resolves `sender` to canonical Phone Number JID in [`lib/contextBuilder.js`](../lib/contextBuilder.js).
- **Group Metadata Cache Invalidation**: Exported `invalidateGroupMetadataCache(chatId)` to allow manual cache clearing upon participant or role changes.
- **Silent Drop for Group Bans**: Returns `SILENT_DROP` for group-banned users in [`lib/middleware.js`](../lib/middleware.js) and enforces early silent drops in [`handler.js`](../handler.js) to prevent bot spam loops.
- **Baileys Protocol Patch**: Bundled `patches/baileys+7.0.0-rc13.patch` via `patch-package` to resolve the `tcToken` crash in Baileys v7.
- **International Country Code Agnosticism**: Added `setting.defaultCountryCode` (default: `"62"`) to replace hardcoded local phone prefixes in target resolution.
- **Documentation Suite**: Created dedicated architectural, command development, database, configuration, and deployment guides under `docs/`.

### Fixed
- **SQLite Group Ban Race Condition**: Removed the destructive `bannedUsers` syncing loop in `saveGroupConfig()`, ensuring direct junction table records in `group_banned_users` are preserved.
- **Media Download DNS Resolution**: Fixed `a.whatsapp.net` DNS lookups in [`lib/Messages.js`](../lib/Messages.js).
- **Webview Key Ownership**: Ensured `fromMe: true` is included in `sendUI()` response keys for reliable group auto-deletion.

### Changed
- **Decoupled Cleanup Configuration**: Moved temporary file expiry and SQLite VACUUM settings to root [`setting.js`](../setting.js).
- **Stripped Domain Bloat**: Removed non-engine heavy dependencies (Puppeteer, Jimp, wa-sticker-formatter) to maintain a lightweight core.

---

## [1.0.0] — 2026-07-13

### Added
- **Core Barebone Engine**: Extracted essential multi-bot architecture into a standalone framework.
- **Pipeline Architecture**: 12-stage message processing pipeline in `handler.js`.
- **SQLite with WAL Mode**: Concurrency-safe SQLite storage powered by `better-sqlite3`.
- **PM2 Multi-Instance Concurrency**: Process clustering with atomic message claims (`message_claims`) and heartbeat discovery (`bot_registry`).
- **Hot-Reloading**: Zero-downtime command and handler reloading via Chokidar and ESM query string cache-busting.
- **Call Protection System**: Automatic call rejection, deduplication cache, progressive warnings, and 4th-call auto-ban.
- **Dynamic Command Registry**: Auto-loading ES module command structure with declarative permission flags.
