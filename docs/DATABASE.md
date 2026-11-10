# Database & Storage Architecture

WA-Bot-Engine uses **SQLite 3** via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) with Write-Ahead Logging (WAL) enabled. This architecture provides zero-configuration local persistence while safely supporting multi-process concurrency across multiple bot instances.

---

## 1. Concurrency & Connection Pragmas

The database connection is established once in [`lib/db.js`](../lib/db.js) and shared across engine modules.

```javascript
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -20000");
```

### Why WAL (Write-Ahead Logging)?
- **Concurrent Readers & Writers**: Read queries never block write queries, and write queries never block read queries. Multiple bot processes managed by PM2 can read and write to `database.db` concurrently without database locking errors.
- **`busy_timeout = 5000`**: If SQLite encounters a transient write lock from another bot instance, it retries for up to 5,000ms before throwing an exception.
- **`synchronous = NORMAL`**: Drastically reduces disk I/O latency while retaining ACID guarantees in WAL mode.

---

## 2. Table Schemas

### `users`
Stores global user metadata, registration state, and ban records.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | Canonical Phone Number JID (`<number>@s.whatsapp.net`). |
| `registered` | `INTEGER` | `DEFAULT 0` | 1 if registered, 0 if guest. |
| `registered_at`| `INTEGER` | `NULLABLE` | Unix timestamp (ms) of registration. |
| `name` | `TEXT` | `NULLABLE` | Display name from WhatsApp pushname. |
| `banned` | `INTEGER` | `DEFAULT 0` | 1 if globally banned, 0 otherwise. |
| `banned_at` | `INTEGER` | `NULLABLE` | Unix timestamp (ms) when ban was issued. |
| `banned_by` | `TEXT` | `NULLABLE` | Canonical JID of the owner/admin who issued the ban. |
| `ban_reason` | `TEXT` | `NULLABLE` | Human-readable reason for the ban. |
| `meta` | `TEXT` | `DEFAULT '{}'` | Serialized JSON object for arbitrary user metadata (e.g. `meta.isBotAdmin`, `meta.callCount`). |

---

### `groups`
Stores group configurations, features, and group-wide ban status.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | Group JID (`<id>@g.us`). |
| `welcome` | `INTEGER` | `DEFAULT 0` | Welcome toggle flag. |
| `welcome_text` | `TEXT` | `DEFAULT ''` | Custom welcome message template. |
| `goodbye` | `INTEGER` | `DEFAULT 0` | Goodbye toggle flag. |
| `goodbye_text` | `TEXT` | `DEFAULT ''` | Custom goodbye message template. |
| `registered` | `INTEGER` | `DEFAULT 0` | 1 if registered in bot registry. |
| `registered_at`| `INTEGER` | `NULLABLE` | Unix timestamp (ms) of registration. |
| `registered_by`| `TEXT` | `NULLABLE` | JID of the user who registered the group. |
| `banned` | `INTEGER` | `DEFAULT 0` | 1 if bot is globally disabled in this group. |
| `banned_at` | `INTEGER` | `NULLABLE` | Unix timestamp (ms) of ban. |
| `banned_by` | `TEXT` | `NULLABLE` | JID of issuer. |
| `ban_reason` | `TEXT` | `NULLABLE` | Reason string. |
| `auto_replies` | `TEXT` | `DEFAULT '{}'` | Serialized JSON dictionary of custom keyword triggers. |
| `meta` | `TEXT` | `DEFAULT '{}'` | Serialized JSON object for arbitrary group metadata. |

---

### `group_banned_users`
Junction table tracking users banned from using the bot within a specific group.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `group_id` | `TEXT` | `NOT NULL` | Group JID (`<id>@g.us`). |
| `user_id` | `TEXT` | `NOT NULL` | Canonical Phone Number JID of the banned user. |
| `banned_at` | `INTEGER` | `NOT NULL` | Unix timestamp (ms). |
| `banned_by` | `TEXT` | `NULLABLE` | Admin/Owner who banned the user. |
| `reason` | `TEXT` | `NULLABLE` | Reason for group-level ban. |

*Primary Key:* `PRIMARY KEY (group_id, user_id)`

---

### `message_claims`
Coordinates message processing among multiple bot instances sharing the same groups.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `stanza_id` | `TEXT` | `PRIMARY KEY` | Unique message ID emitted by WhatsApp (`message.key.id`). |
| `bot_id` | `TEXT` | `NOT NULL` | Instance identifier (`setting.botId`). |
| `created_at` | `INTEGER` | `NOT NULL` | Unix timestamp (ms) of claim. |

*Indexes:* `idx_claims_created ON message_claims(created_at)`

---

### `bot_registry`
Tracks online bot instances for auto-discovery and priority ranking.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `bot_id` | `TEXT` | `PRIMARY KEY` | Configured bot ID (`bot1`, `bot2`, etc.). |
| `jid` | `TEXT` | `NOT NULL` | Phone number JID of the bot instance. |
| `last_seen` | `INTEGER` | `NOT NULL` | Unix timestamp (ms) of latest heartbeat. |

---

### `identity_map`
Passive mapping table between WhatsApp Privacy LIDs (`@lid`) and Phone Number JIDs (`@s.whatsapp.net`).

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `lid` | `TEXT` | `PRIMARY KEY` | Linked Device ID (`<hash>@lid`). |
| `pn` | `TEXT` | `NOT NULL` | Phone Number JID (`<number>@s.whatsapp.net`). |

*Indexes:* `idx_identity_pn ON identity_map(pn)`

---

### `chat_messages`
Stores incoming and outgoing chat history used for sliding-window context retrieval (15 messages) and thread reconstruction in AI userbot workflows.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | WhatsApp stanza ID (`message.key.id`). |
| `chat_jid` | `TEXT` | `NOT NULL` | Conversation JID (group or DM). |
| `sender_jid`| `TEXT` | `NOT NULL` | Canonical Phone Number JID of the sender. |
| `sender_name`| `TEXT` | `NULLABLE` | Display pushname or 'You'. |
| `text` | `TEXT` | `NULLABLE` | Message body text or caption. |
| `media_type`| `TEXT` | `NULLABLE` | Media type (`image`, `video`, `sticker`, etc.). |
| `media_caption`| `TEXT`| `NULLABLE`| Caption or description text for media messages. |
| `quoted_id` | `TEXT` | `NULLABLE` | Stanza ID of the quoted/replied message. |
| `is_from_me`| `INTEGER`| `DEFAULT 0`| 1 if sent by the account owner, 0 otherwise. |
| `is_ai`     | `INTEGER`| `DEFAULT 0`| 1 if generated by AI userbot, 0 if typed manually by owner. |
| `timestamp` | `INTEGER`| `NOT NULL` | Unix timestamp in seconds. |

*Indexes:* `idx_chat_messages_lookup ON chat_messages(chat_jid, timestamp DESC)`, `idx_chat_messages_quoted ON chat_messages(quoted_id)`, `idx_chat_messages_timestamp ON chat_messages(timestamp)`

---

### `ai_global_config`
Key-value store for global AI persona switches and defaults.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `key` | `TEXT` | `PRIMARY KEY` | Config key name (e.g. `enabled`, `default_persona`). |
| `value` | `TEXT` | `NULLABLE` | String value (`1`, `0`, or persona text). |

---

### `ai_chat_settings`
Per-chat configuration controlling AI userbot behavior in individual DMs and groups.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `chat_jid` | `TEXT` | `PRIMARY KEY` | JID of the chat or group. |
| `enabled` | `INTEGER` | `DEFAULT 0` | 1 if AI is enabled in this chat, 0 if disabled. |
| `mode` | `TEXT` | `DEFAULT 'trigger'` | Sensitivity mode: `trigger` (tag/reply/DM) or `command`. |
| `custom_persona`| `TEXT`| `NULLABLE` | Optional prompt persona override for this specific chat. |
| `updated_at` | `INTEGER` | `NULLABLE` | Unix timestamp in seconds of last setting change. |

---

### `ai_group_ignores`
Tracks members ignored by the AI userbot within specific groups.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `chat_jid` | `TEXT` | `NOT NULL` | Group JID (`<id>@g.us`). |
| `user_jid` | `TEXT` | `NOT NULL` | Canonical Phone Number JID of the ignored user. |
| `created_at` | `INTEGER` | `NULLABLE` | Unix timestamp in seconds when ignore was added. |

*Primary Key:* `PRIMARY KEY (chat_jid, user_jid)`

---

## 3. The Canonical JID Rule

> **Never use raw JIDs as primary keys or query arguments for user data.**

Always pass user identifiers through [`toCanonicalUserId(jid)`](../lib/database.js):

```javascript
import { toCanonicalUserId } from "./database.js";

// Input:  "628123456789:12@s.whatsapp.net" -> Output: "628123456789@s.whatsapp.net"
// Input:  "12345678901234@lid"             -> Output: "628123456789@s.whatsapp.net" (via identity_map)
const canonicalId = toCanonicalUserId(rawJid);
```

Every database function inside `lib/database.js` automatically applies this transformation:
- `getUser(userId)`
- `saveUser(userId, data)`
- `banUser(userId, bannedBy, reason)`
- `isBanned(userId)`
- `banUserInGroup(chatId, userId)`
- `isUserGroupBanned(chatId, userId)`

---

## 4. Periodic Maintenance & Space Reclamation

SQLite databases in WAL mode accumulate database pages and wal logs over time. WA-Bot-Engine automatically maintains the database through [`services/cleanup.js`](../services/cleanup.js):

- **Stale Claims Purging**: Claims older than 5 minutes (`setting.claimsPurgeAge`) are purged periodically.
- **Chat History Auto-Pruning**: Messages in `chat_messages` older than 48 hours are automatically purged to prevent disk bloat.
- **Periodic VACUUM**: Executes `VACUUM` every 30 minutes (`setting.vacuumInterval`) to defragment the SQLite database file and reclaim unused disk space.

---

## 5. Database Maintenance & Repair (`repairDatabase()`)

The engine provides an atomic maintenance routine in [`lib/database.js`](../lib/database.js):

```javascript
import { repairDatabase } from "./lib/database.js";
const report = repairDatabase();
```

| Check / Operation | Rule | Affected Table |
|:---|:---|:---|
| **Integrity Check** | `PRAGMA integrity_check` verification | All database pages |
| **Orphan Group Bans** | Remove ban records for groups no longer in `groups` | `group_banned_users` |
| **Stale Claims Purge** | Delete claims older than **10 minutes** | `message_claims` |
| **Stale Registry Purge** | Delete bot heartbeats inactive for **> 10 minutes** | `bot_registry` |
| **Empty User Cleanup** | Delete guest records with no name, no meta, unbanned | `users` |

