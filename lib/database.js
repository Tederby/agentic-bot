/**
 * Database Module — SQLite Backend
 *
 * Core storage for users, groups, multi-bot coordination, and identity mapping.
 * Uses better-sqlite3 with WAL mode (via lib/db.js) for safe
 * concurrent access from multiple bot processes.
 *
 * OPTIONAL FEATURES (can be removed if not needed):
 *  - Ban system (user bans, group bans, group-level user bans)
 *  - Bot admin system (isBotAdmin, setBotAdmin, getAllBotAdmins)
 * These are marked with [OPTIONAL] in their section headers.
 */

import db from "./db.js";
import { jidNormalizedUser } from "baileys";

// ── Default Schemas ─────────────────────────────────────────────────────────

const DEFAULT_USER = {
    registered: false,
    registeredAt: null,
    name: null,
    banned: false,
    bannedAt: null,
    bannedBy: null,
    banReason: null,
    meta: {},
};

const DEFAULT_GROUP = {
    welcome: false,
    welcomeText: "",
    goodbye: false,
    goodbyeText: "",
    registered: false,
    registeredAt: null,
    registeredBy: null,
    bannedUsers: [],
    banned: false,
    bannedAt: null,
    bannedBy: null,
    banReason: null,
    autoReplies: {},
    meta: {},
};

// ── Prepared Statements (cached for performance) ────────────────────────────

const stmts = {
    // Users
    getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
    upsertUser: db.prepare(`
        INSERT INTO users (id, registered, registered_at, name, banned, banned_at, banned_by, ban_reason, meta)
        VALUES (@id, @registered, @registered_at, @name, @banned, @banned_at, @banned_by, @ban_reason, @meta)
        ON CONFLICT(id) DO UPDATE SET
            registered = @registered,
            registered_at = @registered_at,
            name = @name,
            banned = @banned,
            banned_at = @banned_at,
            banned_by = @banned_by,
            ban_reason = @ban_reason,
            meta = @meta
    `),
    allUsers: db.prepare("SELECT * FROM users"),
    allBannedUsers: db.prepare("SELECT * FROM users WHERE banned = 1"),

    // Groups
    getGroup: db.prepare("SELECT * FROM groups WHERE id = ?"),
    upsertGroup: db.prepare(`
        INSERT INTO groups (id, welcome, welcome_text, goodbye, goodbye_text, registered, registered_at, registered_by, banned, banned_at, banned_by, ban_reason, auto_replies, meta)
        VALUES (@id, @welcome, @welcome_text, @goodbye, @goodbye_text, @registered, @registered_at, @registered_by, @banned, @banned_at, @banned_by, @ban_reason, @auto_replies, @meta)
        ON CONFLICT(id) DO UPDATE SET
            welcome = @welcome,
            welcome_text = @welcome_text,
            goodbye = @goodbye,
            goodbye_text = @goodbye_text,
            registered = @registered,
            registered_at = @registered_at,
            registered_by = @registered_by,
            banned = @banned,
            banned_at = @banned_at,
            banned_by = @banned_by,
            ban_reason = @ban_reason,
            auto_replies = @auto_replies,
            meta = @meta
    `),
    allGroups: db.prepare("SELECT * FROM groups"),
    allBannedGroups: db.prepare("SELECT * FROM groups WHERE banned = 1"),

    // Group Banned Users
    getGroupBanned: db.prepare("SELECT user_id FROM group_banned_users WHERE group_id = ?"),
    addGroupBan: db.prepare("INSERT OR IGNORE INTO group_banned_users (group_id, user_id) VALUES (?, ?)"),
    removeGroupBan: db.prepare("DELETE FROM group_banned_users WHERE group_id = ? AND user_id = ?"),
    isGroupBanned: db.prepare("SELECT 1 FROM group_banned_users WHERE group_id = ? AND user_id = ? LIMIT 1"),

    // Multi-Bot Priority
    upsertBotRegistry: db.prepare("INSERT INTO bot_registry (bot_id, jid, last_seen) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET jid = excluded.jid, last_seen = excluded.last_seen"),
    getActiveBots: db.prepare("SELECT bot_id, jid FROM bot_registry WHERE last_seen >= ? ORDER BY bot_id ASC"),
    claimMessage: db.prepare("INSERT INTO message_claims (id, bot_id, created_at) VALUES (?, ?, ?)"),
    purgeOldClaims: db.prepare("DELETE FROM message_claims WHERE created_at < ?"),

    // Identity Mapping (LID ↔ PN)
    upsertIdentity: db.prepare("INSERT INTO identity_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn"),
    resolveByLid: db.prepare("SELECT pn FROM identity_map WHERE lid = ?"),
    resolveByPn: db.prepare("SELECT lid FROM identity_map WHERE pn = ?"),
    allIdentities: db.prepare("SELECT COUNT(*) as c FROM identity_map"),

    // Chat Messages
    insertChatMessage: db.prepare(`
        INSERT OR REPLACE INTO chat_messages (id, chat_jid, sender_jid, sender_name, text, media_type, media_caption, quoted_id, is_from_me, timestamp)
        VALUES (@id, @chat_jid, @sender_jid, @sender_name, @text, @media_type, @media_caption, @quoted_id, @is_from_me, @timestamp)
    `),
    getRecentMessages: db.prepare(`
        SELECT * FROM chat_messages 
        WHERE chat_jid = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
    `),
    getMessageById: db.prepare("SELECT * FROM chat_messages WHERE id = ?"),
    purgeOldChatMessages: db.prepare("DELETE FROM chat_messages WHERE timestamp < ?"),

    // AI Global Config
    getAiGlobalConfig: db.prepare("SELECT value FROM ai_global_config WHERE key = ?"),
    setAiGlobalConfig: db.prepare(`
        INSERT INTO ai_global_config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),

    // AI Chat Settings
    getAiChatSettings: db.prepare("SELECT * FROM ai_chat_settings WHERE chat_jid = ?"),
    upsertAiChatSettings: db.prepare(`
        INSERT INTO ai_chat_settings (chat_jid, enabled, mode, custom_persona, updated_at)
        VALUES (@chat_jid, @enabled, @mode, @custom_persona, @updated_at)
        ON CONFLICT(chat_jid) DO UPDATE SET
            enabled = @enabled,
            mode = @mode,
            custom_persona = @custom_persona,
            updated_at = @updated_at
    `),

    // AI Group Ignores
    isAiIgnored: db.prepare("SELECT 1 FROM ai_group_ignores WHERE chat_jid = ? AND user_jid = ? LIMIT 1"),
    addAiIgnore: db.prepare("INSERT OR IGNORE INTO ai_group_ignores (chat_jid, user_jid, created_at) VALUES (?, ?, ?)"),
    removeAiIgnore: db.prepare("DELETE FROM ai_group_ignores WHERE chat_jid = ? AND user_jid = ?"),
    getAiIgnores: db.prepare("SELECT user_jid, created_at FROM ai_group_ignores WHERE chat_jid = ? ORDER BY created_at ASC"),
};

// ── Row Converters ──────────────────────────────────────────────────────────

function rowToUser(row) {
    if (!row) return null;
    return {
        registered: !!row.registered,
        registeredAt: row.registered_at,
        name: row.name,
        banned: !!row.banned,
        bannedAt: row.banned_at,
        bannedBy: row.banned_by,
        banReason: row.ban_reason,
        meta: safeJsonParse(row.meta, {}),
    };
}

function userToParams(id, data) {
    return {
        id,
        registered: data.registered ? 1 : 0,
        registered_at: data.registeredAt ?? null,
        name: data.name ?? null,
        banned: data.banned ? 1 : 0,
        banned_at: data.bannedAt ?? null,
        banned_by: data.bannedBy ?? null,
        ban_reason: data.banReason ?? null,
        meta: JSON.stringify(data.meta || {}),
    };
}

function rowToGroup(row) {
    if (!row) return null;
    const bannedUsers = stmts.getGroupBanned.all(row.id).map(r => r.user_id);
    return {
        welcome: !!row.welcome,
        welcomeText: row.welcome_text || "",
        goodbye: !!row.goodbye,
        goodbyeText: row.goodbye_text || "",
        registered: !!row.registered,
        registeredAt: row.registered_at,
        registeredBy: row.registered_by,
        bannedUsers,
        banned: !!row.banned,
        bannedAt: row.banned_at,
        bannedBy: row.banned_by,
        banReason: row.ban_reason,
        autoReplies: safeJsonParse(row.auto_replies, {}),
        meta: safeJsonParse(row.meta, {}),
    };
}

function groupToParams(id, data) {
    return {
        id,
        welcome: data.welcome ? 1 : 0,
        welcome_text: data.welcomeText ?? "",
        goodbye: data.goodbye ? 1 : 0,
        goodbye_text: data.goodbyeText ?? "",
        registered: data.registered ? 1 : 0,
        registered_at: data.registeredAt ?? null,
        registered_by: data.registeredBy ?? null,
        banned: data.banned ? 1 : 0,
        banned_at: data.bannedAt ?? null,
        banned_by: data.bannedBy ?? null,
        ban_reason: data.banReason ?? null,
        auto_replies: JSON.stringify(data.autoReplies || {}),
        meta: JSON.stringify(data.meta || {}),
    };
}

function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
}

// ── Core I/O (backward compat) ──────────────────────────────────────────────

/**
 * Get the entire database as a plain object.
 * Used by info.js for stats display. Prefer specific getters for normal use.
 */
export function getDB() {
    const users = {};
    for (const row of stmts.allUsers.all()) {
        users[row.id] = rowToUser(row);
    }
    const groups = {};
    for (const row of stmts.allGroups.all()) {
        groups[row.id] = rowToGroup(row);
    }
    return { users, groups };
}

/**
 * @deprecated Use specific save functions instead.
 * Kept for backward compatibility — performs full upsert of all data.
 */
export function saveDB(data) {
    const tx = db.transaction(() => {
        if (data.users) {
            for (const [id, userData] of Object.entries(data.users)) {
                stmts.upsertUser.run(userToParams(id, { ...DEFAULT_USER, ...userData }));
            }
        }
        if (data.groups) {
            for (const [id, groupData] of Object.entries(data.groups)) {
                stmts.upsertGroup.run(groupToParams(id, { ...DEFAULT_GROUP, ...groupData }));
            }
        }
    });
    tx();
}

// ── Identity Mapping (LID ↔ PN) ────────────────────────────────────────────

/**
 * Save LID ↔ PN mapping. Called passively by contextBuilder
 * whenever a sender is successfully resolved in LID mode groups.
 */
export function saveIdentityMapping(lid, pn) {
    if (!lid || !pn || lid === pn) return;
    if (!lid.endsWith("@lid")) return;
    stmts.upsertIdentity.run(lid, pn);
}

/**
 * Resolve JID to canonical form (PN / @s.whatsapp.net).
 * - If input is already PN → return as-is.
 * - If input is LID → look up PN from identity_map.
 * - Fallback: return input unchanged.
 */
export function resolveUserId(jid) {
    if (!jid) return jid;
    if (jid.endsWith("@s.whatsapp.net")) return jid;
    if (jid.endsWith("@lid")) {
        const row = stmts.resolveByLid.get(jid);
        return row ? row.pn : jid;
    }
    return jid;
}

/**
 * Convert any JID (LID or PN with device ID) to canonical PN form.
 * Ensures consistent lookups across all tables and operations.
 */
export function toCanonicalUserId(jid) {
    if (!jid) return jid;
    return resolveUserId(jidNormalizedUser(jid));
}

/**
 * Reverse resolve: PN → LID.
 * Useful for admin check in LID mode groups.
 */
export function resolveToLid(jid) {
    if (!jid) return null;
    if (jid.endsWith("@lid")) return jid;
    if (jid.endsWith("@s.whatsapp.net")) {
        const row = stmts.resolveByPn.get(jid);
        return row ? row.lid : null;
    }
    return null;
}

/**
 * Scan all participants in a group and save LID→PN mappings.
 * Called manually by a scanids command (owner/admin only).
 * @returns {{ saved: number, total: number }}
 */
export function scanGroupIdentities(participants) {
    let saved = 0;
    const total = participants.length;
    const tx = db.transaction(() => {
        for (const p of participants) {
            if (p.id && p.phoneNumber && p.id.endsWith("@lid")) {
                stmts.upsertIdentity.run(p.id, p.phoneNumber);
                saved++;
            }
        }
    });
    tx();
    return { saved, total };
}

/**
 * Get the number of stored identity mappings.
 */
export function getIdentityCount() {
    return stmts.allIdentities.get().c;
}

// ── User Operations ─────────────────────────────────────────────────────────

/**
 * Get user record, initializing with defaults if not found.
 */
export function getUser(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    if (!row) {
        stmts.upsertUser.run(userToParams(canonicalId, DEFAULT_USER));
        return { ...DEFAULT_USER };
    }
    return { ...DEFAULT_USER, ...rowToUser(row) };
}

/**
 * Save user data back to database.
 */
export function saveUser(userId, data) {
    const canonicalId = toCanonicalUserId(userId);
    stmts.upsertUser.run(userToParams(canonicalId, { ...DEFAULT_USER, ...data }));
}

/**
 * Register a user.
 */
export function registerUser(userId, name) {
    const canonicalId = toCanonicalUserId(userId);
    const current = getUser(canonicalId);
    current.registered = true;
    current.registeredAt = Date.now();
    current.name = name || current.name;
    saveUser(canonicalId, current);
    return current;
}

/**
 * Unregister a user (keep record but reset registration).
 */
export function unregisterUser(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    if (!row) return;
    const user = rowToUser(row);
    user.registered = false;
    user.registeredAt = null;
    saveUser(canonicalId, user);
}

/**
 * Quick check: is user registered?
 */
export function isRegistered(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    return row ? !!row.registered : false;
}

// ── [OPTIONAL] Bot Admin ─────────────────────────────────────────────────────────
// Remove this section if you don't need a bot admin hierarchy.──

/**
 * Quick check: is user a bot admin (via database)?
 */
export function isBotAdmin(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    if (!row) return false;
    const user = rowToUser(row);
    return user.meta?.isBotAdmin === true;
}

/**
 * Set bot admin status for a user.
 */
export function setBotAdmin(userId, status) {
    const canonicalId = toCanonicalUserId(userId);
    const current = getUser(canonicalId);
    current.meta = current.meta || {};
    current.meta.isBotAdmin = status;
    saveUser(canonicalId, current);
    return current;
}

/**
 * Get all Bot Admins.
 */
export function getAllBotAdmins() {
    const rows = stmts.allUsers.all();
    const admins = [];
    for (const row of rows) {
        const meta = JSON.parse(row.meta || "{}");
        if (meta.isBotAdmin) {
            admins.push(row.id);
        }
    }
    return admins;
}

// ── [OPTIONAL] User Ban (Global) ───────────────────────────────────────────
// Remove this section if you don't need user banning.

/**
 * Ban a user globally. They cannot use the bot anywhere.
 */
export function banUser(userId, bannedBy, reason) {
    const canonicalId = toCanonicalUserId(userId);
    const current = getUser(canonicalId);
    current.banned = true;
    current.bannedAt = Date.now();
    current.bannedBy = bannedBy ? toCanonicalUserId(bannedBy) : null;
    current.banReason = reason || null;
    current.meta = current.meta || {};
    current.meta.callCount = 0;
    saveUser(canonicalId, current);
    return current;
}

/**
 * Unban a user globally.
 */
export function unbanUser(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    if (!row) return;
    const user = rowToUser(row);
    user.banned = false;
    user.bannedAt = null;
    user.bannedBy = null;
    user.banReason = null;
    user.meta = user.meta || {};
    user.meta.callCount = 0;
    saveUser(canonicalId, user);
}

/**
 * Quick check: is user globally banned?
 */
export function isBanned(userId) {
    const canonicalId = toCanonicalUserId(userId);
    const row = stmts.getUser.get(canonicalId);
    return row ? !!row.banned : false;
}

/**
 * List all globally banned users.
 * @returns {Array<{userId: string, data: object}>}
 */
export function getAllBannedUsers() {
    return stmts.allBannedUsers.all().map(row => ({
        userId: row.id,
        data: rowToUser(row),
    }));
}

// ── Group Operations ────────────────────────────────────────────────────────

/**
 * Get group config, initializing with defaults if not found.
 * Backward-compatible with existing welcome/goodbye data.
 */
export function getGroupConfig(chatId) {
    const row = stmts.getGroup.get(chatId);
    if (!row) {
        stmts.upsertGroup.run(groupToParams(chatId, DEFAULT_GROUP));
        return { ...DEFAULT_GROUP, bannedUsers: [], autoReplies: {} };
    }
    const merged = { ...DEFAULT_GROUP, ...rowToGroup(row) };
    if (!Array.isArray(merged.bannedUsers)) merged.bannedUsers = [];
    if (!merged.autoReplies || typeof merged.autoReplies !== "object" || Array.isArray(merged.autoReplies)) {
        merged.autoReplies = {};
    }
    return merged;
}

/**
 * Save group config back to database.
 */
export function saveGroupConfig(chatId, config) {
    stmts.upsertGroup.run(groupToParams(chatId, { ...DEFAULT_GROUP, ...config }));
}

/**
 * Register a group.
 */
export function registerGroup(chatId, registeredBy) {
    const current = getGroupConfig(chatId);
    current.registered = true;
    current.registeredAt = Date.now();
    current.registeredBy = registeredBy;
    saveGroupConfig(chatId, current);
    return current;
}

/**
 * Unregister a group (keep record but reset registration).
 */
export function unregisterGroup(chatId) {
    const row = stmts.getGroup.get(chatId);
    if (!row) return;
    const group = rowToGroup(row);
    group.registered = false;
    group.registeredAt = null;
    group.registeredBy = null;
    saveGroupConfig(chatId, group);
}

// ── [OPTIONAL] Group Ban (Global) ──────────────────────────────────────────
// Remove this section if you don't need group banning.────

/**
 * Ban a group globally. Bot stops responding in this group.
 */
export function banGroup(chatId, bannedBy, reason) {
    const current = getGroupConfig(chatId);
    current.banned = true;
    current.bannedAt = Date.now();
    current.bannedBy = bannedBy;
    current.banReason = reason || null;
    saveGroupConfig(chatId, current);
    return current;
}

/**
 * Unban a group globally.
 */
export function unbanGroup(chatId) {
    const row = stmts.getGroup.get(chatId);
    if (!row) return;
    const group = rowToGroup(row);
    group.banned = false;
    group.bannedAt = null;
    group.bannedBy = null;
    group.banReason = null;
    saveGroupConfig(chatId, group);
}

/**
 * Quick check: is group globally banned?
 */
export function isGroupBanned(chatId) {
    const row = stmts.getGroup.get(chatId);
    return row ? !!row.banned : false;
}

/**
 * List all globally banned groups.
 * @returns {Array<{chatId: string, data: object}>}
 */
export function getAllBannedGroups() {
    return stmts.allBannedGroups.all().map(row => ({
        chatId: row.id,
        data: rowToGroup(row),
    }));
}

// ── [OPTIONAL] Group-Level User Ban ────────────────────────────────────────
// Remove this section if you don't need per-group user banning.

/**
 * Ban a user in a specific group.
 */
export function banUserInGroup(chatId, userId) {
    const canonicalId = toCanonicalUserId(userId);
    stmts.addGroupBan.run(chatId, canonicalId);
}

/**
 * Unban a user in a specific group.
 */
export function unbanUserInGroup(chatId, userId) {
    const canonicalId = toCanonicalUserId(userId);
    stmts.removeGroupBan.run(chatId, canonicalId);
}

/**
 * Quick check: is user banned in a specific group?
 */
export function isUserGroupBanned(chatId, userId) {
    const canonicalId = toCanonicalUserId(userId);
    return !!stmts.isGroupBanned.get(chatId, canonicalId);
}

/**
 * List all banned users in a specific group.
 * @returns {string[]}
 */
export function getGroupBannedUsers(chatId) {
    return stmts.getGroupBanned.all(chatId).map(r => r.user_id);
}

// ── Multi-Bot Priority System ───────────────────────────────────────────────

export function upsertBotRegistry(botId, jid) {
    stmts.upsertBotRegistry.run(botId, jid, Date.now());
}

export function getActiveBotsInGroup(participantJids) {
    // 2 minutes expiry
    const cutoff = Date.now() - 120000;
    const activeBots = stmts.getActiveBots.all(cutoff);
    
    // Filter active bots to those present in the group
    return activeBots
        .filter(b => participantJids.includes(b.jid))
        .map(b => b.jid);
}

export function claimMessage(stanzaId, botId) {
    try {
        stmts.claimMessage.run(stanzaId, botId, Date.now());
        return true;
    } catch (err) {
        // UNIQUE constraint failed - another bot claimed it
        return false;
    }
}

export function purgeOldClaims(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    stmts.purgeOldClaims.run(cutoff);
}



// ── Efficient Stats (avoids loading all rows) ───────────────────────────────

const statsStmts = {
    totalUsers: db.prepare("SELECT COUNT(*) as c FROM users"),
    registeredUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE registered = 1"),
    bannedUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE banned = 1"),
    totalGroups: db.prepare("SELECT COUNT(*) as c FROM groups"),
    registeredGroups: db.prepare("SELECT COUNT(*) as c FROM groups WHERE registered = 1"),
    bannedGroups: db.prepare("SELECT COUNT(*) as c FROM groups WHERE banned = 1"),
};

/**
 * Get database statistics using efficient COUNT queries.
 * Much faster than loading all rows with getDB().
 */
export function getDBStats() {
    return {
        totalUsers: statsStmts.totalUsers.get().c,
        registeredUsers: statsStmts.registeredUsers.get().c,
        bannedUsers: statsStmts.bannedUsers.get().c,
        totalGroups: statsStmts.totalGroups.get().c,
        registeredGroups: statsStmts.registeredGroups.get().c,
        bannedGroups: statsStmts.bannedGroups.get().c,
    };
}

// ── Database Maintenance & Repair ───────────────────────────────────────────

/**
 * Run comprehensive database repair and return a report.
 * Cleans orphan records, stale claims, and dead registry entries.
 */
export function repairDatabase() {
    const report = {
        integrityOk: false,
        orphanGroupBans: 0,
        staleClaims: 0,
        staleRegistry: 0,
        emptyUsers: 0,
    };

    // 1. SQLite integrity check
    const integrityResult = db.pragma("integrity_check");
    report.integrityOk = integrityResult[0]?.integrity_check === "ok";

    const tx = db.transaction(() => {
        // 2. Clean orphan group_banned_users (group no longer exists in groups table)
        const orphans = db.prepare(`
            DELETE FROM group_banned_users 
            WHERE group_id NOT IN (SELECT id FROM groups)
        `).run();
        report.orphanGroupBans = orphans.changes;

        // 3. Purge all expired message_claims (older than 10 minutes)
        const claims = db.prepare(`
            DELETE FROM message_claims WHERE created_at < ?
        `).run(Date.now() - 10 * 60 * 1000);
        report.staleClaims = claims.changes;

        // 4. Purge stale bot registry entries (offline > 10 minutes)
        const registry = db.prepare(`
            DELETE FROM bot_registry WHERE last_seen < ?
        `).run(Date.now() - 10 * 60 * 1000);
        report.staleRegistry = registry.changes;

        // 5. Clean empty users (unregistered, unbanned, no meaningful meta)
        const emptyUsers = db.prepare(`
            DELETE FROM users 
            WHERE registered = 0 
            AND banned = 0 
            AND (meta IS NULL OR meta = '{}' OR meta = '')
            AND name IS NULL
        `).run();
        report.emptyUsers = emptyUsers.changes;
    });
    tx();

    return report;
}

// ── Chat Messages & AI Userbot Storage ──────────────────────────────────────

/**
 * Save or update a chat message in history.
 * @param {object} msg
 */
export function saveChatMessage(msg) {
    if (!msg || !msg.id || !msg.chat_jid) return;
    stmts.insertChatMessage.run({
        id: msg.id,
        chat_jid: msg.chat_jid,
        sender_jid: msg.sender_jid || "",
        sender_name: msg.sender_name || null,
        text: msg.text || "",
        media_type: msg.media_type || null,
        media_caption: msg.media_caption || null,
        quoted_id: msg.quoted_id || null,
        is_from_me: msg.is_from_me ? 1 : 0,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    });
}

/**
 * Get recent messages in chronological order (oldest to newest).
 * @param {string} chatJid
 * @param {number} [limit=15]
 * @returns {Array}
 */
export function getRecentChatMessages(chatJid, limit = 15) {
    if (!chatJid) return [];
    const rows = stmts.getRecentMessages.all(chatJid, limit);
    return rows.reverse(); // Return in chronological order
}

/**
 * Get message by its stanzaId / id.
 * @param {string} id
 * @returns {object|null}
 */
export function getChatMessageById(id) {
    if (!id) return null;
    return stmts.getMessageById.get(id) || null;
}

/**
 * Purge chat messages older than maxAgeSec (default: 48 hours).
 * @param {number} [maxAgeSec=172800]
 * @returns {number} Number of deleted rows
 */
export function purgeOldChatMessages(maxAgeSec = 172800) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const info = stmts.purgeOldChatMessages.run(cutoff);
    return info.changes;
}

// ── AI Global Config ────────────────────────────────────────────────────────

export function getAiGlobalConfig(key, defaultValue = null) {
    const row = stmts.getAiGlobalConfig.get(key);
    return row ? row.value : defaultValue;
}

export function setAiGlobalConfig(key, value) {
    stmts.setAiGlobalConfig.run(key, String(value));
}

export function isAiGlobalEnabled() {
    return getAiGlobalConfig("enabled", "0") === "1";
}

// ── AI Chat Settings ────────────────────────────────────────────────────────

export function getAiChatSettings(chatJid) {
    if (!chatJid) return null;
    const row = stmts.getAiChatSettings.get(chatJid);
    if (!row) {
        return {
            chat_jid: chatJid,
            enabled: false,
            mode: "trigger",
            custom_persona: null,
            updated_at: null,
        };
    }
    return {
        chat_jid: row.chat_jid,
        enabled: row.enabled === 1,
        mode: row.mode || "trigger",
        custom_persona: row.custom_persona || null,
        updated_at: row.updated_at,
    };
}

export function setAiChatSettings(chatJid, settings = {}) {
    if (!chatJid) return;
    const existing = getAiChatSettings(chatJid);
    const enabled = settings.enabled !== undefined ? (settings.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
    const mode = settings.mode || existing.mode || "trigger";
    const custom_persona = settings.custom_persona !== undefined ? settings.custom_persona : existing.custom_persona;
    
    stmts.upsertAiChatSettings.run({
        chat_jid: chatJid,
        enabled,
        mode,
        custom_persona: custom_persona || null,
        updated_at: Math.floor(Date.now() / 1000),
    });
}

// ── AI Group Ignores ────────────────────────────────────────────────────────

export function isUserAiIgnored(chatJid, userJid) {
    if (!chatJid || !userJid) return false;
    const row = stmts.isAiIgnored.get(chatJid, userJid);
    return !!row;
}

export function addAiIgnore(chatJid, userJid) {
    if (!chatJid || !userJid) return false;
    const info = stmts.addAiIgnore.run(chatJid, userJid, Math.floor(Date.now() / 1000));
    return info.changes > 0;
}

export function removeAiIgnore(chatJid, userJid) {
    if (!chatJid || !userJid) return false;
    const info = stmts.removeAiIgnore.run(chatJid, userJid);
    return info.changes > 0;
}

export function getAiIgnores(chatJid) {
    if (!chatJid) return [];
    return stmts.getAiIgnores.all(chatJid);
}




