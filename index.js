// ============================================================
// JJS MODERATION / TRYOUT BOT
// discord.js v14 + better-sqlite3
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const Database = require("better-sqlite3");
require("dotenv").config();

// ============================================================
// ENV
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || TOKEN.includes("your_")) {
  console.error("❌ DISCORD_TOKEN is missing or still using a placeholder value.");
  process.exit(1);
}

if (!CLIENT_ID || CLIENT_ID === "your_discord_application_client_id_here") {
  console.error("❌ CLIENT_ID is missing. Add your Discord application/client ID to .env.");
  process.exit(1);
}

if (!GUILD_ID || GUILD_ID === "your_server_id_here") {
  console.error("❌ GUILD_ID is missing. Add your Discord server ID to .env.");
  process.exit(1);
}

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [
    Partials.GuildMember,
    Partials.User,
    Partials.Message
  ]
});

client.on("error", error => {
  if (error && (error.code === 10062 || error.message === "Unknown interaction")) {
    console.warn("⚠️ Ignored stale Discord interaction.");
    return;
  }

  console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
  if (error && (error.code === 10062 || error.message === "Unknown interaction")) {
    console.warn("⚠️ Ignored stale Discord interaction rejection.");
    return;
  }

  console.error("Unhandled promise rejection:", error);
});

// ============================================================
// DATABASE
// ============================================================

const DB_PATH = process.env.DB_PATH || "jjsbot.db";
require("fs").mkdirSync(require("path").dirname(require("path").resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  blacklist_channel_id TEXT,
  unblacklist_channel_id TEXT,
  log_channel_id TEXT,
  log_events_json TEXT,
  server_log_channel_id TEXT,
  server_logs_enabled INTEGER DEFAULT 0,
  auto_ping_channel_id TEXT,
  auto_ping_enabled INTEGER DEFAULT 0,
  appeal_link TEXT,
  setup_complete INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prefixes (
  guild_id TEXT PRIMARY KEY,
  prefixes_json TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS command_roles (
  guild_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, command_name, role_id)
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_number INTEGER,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  roles_count INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS anti_nuke_whitelist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS honeypot_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);
`);

db.exec(`
INSERT OR IGNORE INTO command_roles (guild_id, command_name, role_id)
SELECT guild_id, 'warns', role_id
FROM command_roles
WHERE command_name = 'checkwarns';
DELETE FROM command_roles WHERE command_name = 'checkwarns';
INSERT OR IGNORE INTO command_roles (guild_id, command_name, role_id)
SELECT guild_id, 'raid', role_id
FROM command_roles
WHERE command_name = 'raidmode';
DELETE FROM command_roles WHERE command_name IN ('raidmode', 'ban');
`);

const blacklistColumns = new Set(db.prepare("PRAGMA table_info(blacklist_records)").all().map(column => column.name));
if (!blacklistColumns.has("case_number")) {
  db.exec("ALTER TABLE blacklist_records ADD COLUMN case_number INTEGER");
}

const unnumberedBlacklistRecords = db.prepare(`
  SELECT id, guild_id
  FROM blacklist_records
  WHERE case_number IS NULL
  ORDER BY guild_id, created_at, id
`).all();
const nextCaseByGuild = new Map();
const getLastCaseNumber = db.prepare(`
  SELECT COALESCE(MAX(case_number), 0) AS case_number
  FROM blacklist_records
  WHERE guild_id = ?
`);
const setCaseNumber = db.prepare(`UPDATE blacklist_records SET case_number = ? WHERE id = ?`);
for (const record of unnumberedBlacklistRecords) {
  if (!nextCaseByGuild.has(record.guild_id)) {
    nextCaseByGuild.set(record.guild_id, getLastCaseNumber.get(record.guild_id).case_number);
  }
  const caseNumber = nextCaseByGuild.get(record.guild_id) + 1;
  nextCaseByGuild.set(record.guild_id, caseNumber);
  setCaseNumber.run(caseNumber, record.id);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_case_number ON blacklist_records (guild_id, case_number)");

const settingsColumns = new Set(db.prepare("PRAGMA table_info(settings)").all().map(column => column.name));
if (!settingsColumns.has("log_channel_id")) {
  db.exec("ALTER TABLE settings ADD COLUMN log_channel_id TEXT");
}
if (!settingsColumns.has("log_events_json")) {
  db.exec("ALTER TABLE settings ADD COLUMN log_events_json TEXT");
}
if (!settingsColumns.has("server_log_channel_id")) {
  db.exec("ALTER TABLE settings ADD COLUMN server_log_channel_id TEXT");
}
if (!settingsColumns.has("server_logs_enabled")) {
  db.exec("ALTER TABLE settings ADD COLUMN server_logs_enabled INTEGER DEFAULT 0");
}
if (!settingsColumns.has("auto_ping_channel_id")) {
  db.exec("ALTER TABLE settings ADD COLUMN auto_ping_channel_id TEXT");
}
if (!settingsColumns.has("auto_ping_enabled")) {
  db.exec("ALTER TABLE settings ADD COLUMN auto_ping_enabled INTEGER DEFAULT 0");
}
if (!settingsColumns.has("appeal_link")) {
  db.exec("ALTER TABLE settings ADD COLUMN appeal_link TEXT");
}

// ============================================================
// CONSTANTS
// ============================================================

const COMMANDS = [
  "help",
  "serverinfo",
  "userinfo",
  "autoping",
  "warn",
  "warns",
  "strike",
  "strikecheck",
  "strikelist",
  "deletewarns",
  "kick",
  "case",
  "editcase",
  "raid",
  "logs",
  "blacklist",
  "blacklistlist",
  "blacklistcheck",
  "unblacklist",
  "mute",
  "unmute",
  "modlogs",
  "purge",
  "slowmode",
  "lock",
  "unlock",
  "addrole",
  "removerole",
  "temprole"
];

const LOG_EVENT_OPTIONS = [
  { label: "Moderation actions", value: "moderation", description: "Warnings, mutes, bans, kicks, blacklists, and role commands" },
  { label: "Member joins and leaves", value: "members", description: "Members joining or leaving the server" },
  { label: "Role changes", value: "roles", description: "Roles added to or removed from members" },
  { label: "Nickname changes", value: "member_updates", description: "Member nicknames changed in the server" },
  { label: "Ban and unban events", value: "bans", description: "Ban or unban events detected by Discord" }
];

const SERVER_AUDIT_ACTIONS = new Set([
  AuditLogEvent.GuildUpdate,
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberPrune,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberMove,
  AuditLogEvent.MemberDisconnect,
  AuditLogEvent.BotAdd,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.InviteCreate,
  AuditLogEvent.InviteUpdate,
  AuditLogEvent.InviteDelete,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookUpdate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.EmojiCreate,
  AuditLogEvent.EmojiUpdate,
  AuditLogEvent.EmojiDelete,
  AuditLogEvent.MessageDelete,
  AuditLogEvent.MessageBulkDelete,
  AuditLogEvent.MessagePin,
  AuditLogEvent.MessageUnpin,
  AuditLogEvent.ApplicationCommandPermissionUpdate,
  AuditLogEvent.IntegrationCreate,
  AuditLogEvent.IntegrationUpdate,
  AuditLogEvent.IntegrationDelete,
  AuditLogEvent.StageInstanceCreate,
  AuditLogEvent.StageInstanceUpdate,
  AuditLogEvent.StageInstanceDelete,
  AuditLogEvent.StickerCreate,
  AuditLogEvent.StickerUpdate,
  AuditLogEvent.StickerDelete,
  AuditLogEvent.GuildScheduledEventCreate,
  AuditLogEvent.GuildScheduledEventUpdate,
  AuditLogEvent.GuildScheduledEventDelete,
  AuditLogEvent.ThreadCreate,
  AuditLogEvent.ThreadUpdate,
  AuditLogEvent.ThreadDelete,
  AuditLogEvent.SoundboardSoundCreate,
  AuditLogEvent.SoundboardSoundUpdate,
  AuditLogEvent.SoundboardSoundDelete,
  AuditLogEvent.AutoModerationRuleCreate,
  AuditLogEvent.AutoModerationRuleUpdate,
  AuditLogEvent.AutoModerationRuleDelete,
  AuditLogEvent.AutoModerationBlockMessage,
  AuditLogEvent.AutoModerationFlagToChannel,
  AuditLogEvent.AutoModerationUserCommunicationDisabled,
  AuditLogEvent.AutoModerationQuarantineUser,
  AuditLogEvent.CreatorMonetizationRequestCreated,
  AuditLogEvent.CreatorMonetizationTermsAccepted,
  AuditLogEvent.OnboardingPromptCreate,
  AuditLogEvent.OnboardingPromptUpdate,
  AuditLogEvent.OnboardingPromptDelete,
  AuditLogEvent.OnboardingCreate,
  AuditLogEvent.OnboardingUpdate,
  AuditLogEvent.HomeSettingsCreate,
  AuditLogEvent.HomeSettingsUpdate,
  AuditLogEvent.VoiceChannelStatusCreate,
  AuditLogEvent.VoiceChannelStatusDelete
].filter(action => action !== undefined));

const USER_AUDIT_ACTIONS = new Set([
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.MemberMove,
  AuditLogEvent.MemberDisconnect,
  AuditLogEvent.BotAdd,
  AuditLogEvent.MessageDelete
].filter(action => action !== undefined));

const PREFIX_OPTIONS = [
  "!",
  ".",
  "?",
  "-",
  ">",
  ",",
  "+"
];

const GRADE_ROLES = [
  "Grade 5",
  "Grade 4",
  "Grade 3",
  "Grade 2",
  "Semi Grade 1",
  "Grade 1",
  "Special Grade 1",
  "Special Grade"
];

const SUB1_ROLES = [
  "Low",
  "Mid",
  "High"
];

const SUB2_ROLES = [
  "Weak",
  "Stable",
  "Strong"
];

const BLACKLIST_ROLE_NAME = "Blacklisted";
const GHOST_PING_DELAY_MS = 2000;

const SECURITY_LIMITS = {
  raidJoinCount: 8,
  raidWindowMs: 10000,
  raidTimeoutMs: 24 * 60 * 60 * 1000,
  nukeActionCount: 3,
  nukeWindowMs: 10000,
  channelDeleteCount: 5,
  channelDeleteWindowMs: 10000
};

const HIGH_RISK_ROLE_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks
];

const CRITICAL_AUDIT_ACTIONS = new Set([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberKick,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.WebhookUpdate
]);

const recentJoinWindows = new Map();
const raidProtectionUntil = new Map();
const nukeActionWindows = new Map();
const channelDeleteWindows = new Map();
const honeypotAlertCooldowns = new Map();

const CATEGORY_CHOICES = [
  { name: "⚖️ Appealable", value: "⚖️ Appealable" },
  { name: "❌ Unappealable", value: "❌ Unappealable" },
  { name: "💸 Bail", value: "💸 Bail" }
];

function now() {
  return Date.now();
}

function safeText(text) {
  if (!text) return "None";

  return String(text)
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .slice(0, 1024);
}

function userMention(id) {
  return `<@${id}>`;
}

function roleMention(id) {
  return `<@&${id}>`;
}

function channelMention(id) {
  return id ? `<#${id}>` : "Not set";
}

function timestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function publicEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function errorEmbed(description) {
  return new EmbedBuilder()
    .setTitle("❌ Error")
    .setDescription(description)
    .setColor(0xED4245)
    .setTimestamp();
}

function ensureSettings(guildId) {
  db.prepare(`
    INSERT OR IGNORE INTO settings (guild_id)
    VALUES (?)
  `).run(guildId);
}

function getSettings(guildId) {
  ensureSettings(guildId);
  return db.prepare(`
    SELECT *
    FROM settings
    WHERE guild_id = ?
  `).get(guildId);
}

function getEnabledLogEvents(settings) {
  if (!settings.log_events_json) return LOG_EVENT_OPTIONS.map(option => option.value);

  try {
    const saved = JSON.parse(settings.log_events_json);
    return LOG_EVENT_OPTIONS.map(option => option.value).filter(value => saved.includes(value));
  } catch {
    return LOG_EVENT_OPTIONS.map(option => option.value);
  }
}

function saveEnabledLogEvents(guildId, values) {
  const allowed = new Set(LOG_EVENT_OPTIONS.map(option => option.value));
  const selected = [...new Set(values)].filter(value => allowed.has(value));
  db.prepare(`UPDATE settings SET log_events_json = ? WHERE guild_id = ?`).run(JSON.stringify(selected), guildId);
}

function setAutoPingChannel(guildId, channelId, enabled = true) {
  db.prepare(`
    UPDATE settings
    SET auto_ping_channel_id = ?, auto_ping_enabled = ?
    WHERE guild_id = ?
  `).run(channelId, enabled ? 1 : 0, guildId);
}

function disableAutoPing(guildId) {
  db.prepare(`
    UPDATE settings
    SET auto_ping_channel_id = NULL, auto_ping_enabled = 0
    WHERE guild_id = ?
  `).run(guildId);
}

function getPrefixes(guildId) {
  const row = db.prepare(`
    SELECT prefixes_json
    FROM prefixes
    WHERE guild_id = ?
  `).get(guildId);

  if (!row) return [];

  try {
    return JSON.parse(row.prefixes_json).filter(prefix => PREFIX_OPTIONS.includes(prefix));
  } catch {
    return [];
  }
}

function savePrefixes(guildId, values) {
  const clean = [...new Set(values)].filter(prefix => PREFIX_OPTIONS.includes(prefix));

  db.prepare(`
    INSERT INTO prefixes (guild_id, prefixes_json)
    VALUES (?, ?)
    ON CONFLICT(guild_id)
    DO UPDATE SET prefixes_json = excluded.prefixes_json
  `).run(guildId, JSON.stringify(clean));
}

function getCommandRoles(guildId, commandName) {
  return db.prepare(`
    SELECT role_id
    FROM command_roles
    WHERE guild_id = ?
    AND command_name = ?
  `).all(guildId, commandName).map(row => row.role_id);
}

function setCommandRoles(guildId, commandName, roleIds) {
  const transaction = db.transaction(() => {
    db.prepare(`
      DELETE FROM command_roles
      WHERE guild_id = ?
      AND command_name = ?
    `).run(guildId, commandName);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO command_roles (guild_id, command_name, role_id)
      VALUES (?, ?, ?)
    `);

    for (const roleId of [...new Set(roleIds)]) {
      insert.run(guildId, commandName, roleId);
    }
  });

  transaction();
}

function hasCommandAccess(interactionOrMessage, commandName) {
  const member = interactionOrMessage.member;

  if (!member) return false;

  if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const allowed = getCommandRoles(interactionOrMessage.guild.id, commandName);
  if (!allowed.length && commandName === "strikecheck") {
    const strikeRoles = getCommandRoles(interactionOrMessage.guild.id, "strike");
    if (strikeRoles.length) return strikeRoles.some(roleId => member.roles.cache.has(roleId));
  }
  if (!allowed.length && ["strike", "strikecheck", "strikelist"].includes(commandName)) {
    return canActivateSecurityCommand(interactionOrMessage.guild, member);
  }
  if (!allowed.length && commandName === "blacklistlist") {
    return member.permissions?.has(PermissionFlagsBits.ModerateMembers) || false;
  }
  if (!allowed.length && commandName === "purge") {
    return member.permissions?.has(PermissionFlagsBits.ManageMessages) || false;
  }
  if (!allowed.length && ["addrole", "removerole", "temprole"].includes(commandName)) {
    return member.permissions?.has(PermissionFlagsBits.ManageRoles) || false;
  }
  return allowed.some(roleId => member.roles.cache.has(roleId));
}

function canBypassHoneypot(member) {
  if (!member || !member.guild) return false;

  return member.id === member.guild.ownerId ||
    member.permissions?.has(PermissionFlagsBits.Administrator) ||
    member.permissions?.has(PermissionFlagsBits.ManageGuild);
}

async function setChannelLock(guild, channel, shouldLock) {
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
    return { error: "This command can only be used in a text or announcement channel." };
  }

  const botPermissions = channel.permissionsFor(guild.members.me);
  if (!botPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return { error: "I need the Manage Channels permission to change channel access." };
  }

  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: shouldLock ? false : null });
    return { channel, locked: shouldLock };
  } catch (error) {
    console.error(`${shouldLock ? "lock" : "unlock"} failed:`, error);
    return { error: "I couldn't update this channel's permissions. Check my role and channel permissions." };
  }
}

async function sendGuildLogEmbed(guildId, action, userId, moderatorId, reason, extraDescription = null) {
  const settings = getSettings(guildId);
  if (!settings.log_channel_id) return;
  if (!getEnabledLogEvents(settings).includes("moderation")) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(settings.log_channel_id);
    if (!channel || !channel.isTextBased()) return;

    const safeReason = safeText(reason || "No reason provided");
    const actionLabel = String(action || "event").toUpperCase();
    const description = extraDescription || `${userMention(userId)} • by ${userMention(moderatorId)}`;
    const embed = publicEmbed(`📝 Log Event: ${actionLabel}`, description, 0x5865F2).addFields(
      { name: "Action", value: actionLabel, inline: true },
      { name: "User", value: userMention(userId), inline: true },
      { name: "Moderator", value: userMention(moderatorId), inline: true },
      { name: "Reason", value: safeReason }
    );

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch {
    // no-op
  }
}

function addModLog(guildId, action, userId, moderatorId, reason, extraDescription = null) {
  const createdAt = now();
  db.prepare(`
    INSERT INTO moderation (guild_id, action, user_id, moderator_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, action, userId, moderatorId, reason || null, createdAt);

  sendGuildLogEmbed(guildId, action, userId, moderatorId, reason, extraDescription);
}

async function logGuildEvent(guild, title, description, color = 0x5865F2, eventType = "moderation") {
  if (!guild || !guild.id) return;

  const settings = getSettings(guild.id);
  if (!settings.log_channel_id) return;
  if (!getEnabledLogEvents(settings).includes(eventType)) return;

  try {
    const channel = guild.channels.cache.get(settings.log_channel_id);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({ embeds: [publicEmbed(title, description, color)] }).catch(() => {});
  } catch {
    // no-op
  }
}

async function findRecentAuditEntry(guild, action, targetId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const auditLogs = await guild.fetchAuditLogs({ type: action, limit: 6 });
      const entry = auditLogs.entries.find(candidate => {
        const entryTargetId = candidate.targetId || candidate.target?.id;
        const age = Date.now() - candidate.createdTimestamp;
        return entryTargetId === targetId && age >= 0 && age <= 15000;
      });
      if (entry) return entry;
    } catch (error) {
      console.warn(`Could not fetch audit logs for ${guild.name}:`, error.message);
      return null;
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return null;
}

async function sendServerAuditLog(guild, embed) {
  const settings = getSettings(guild.id);
  if (!settings.server_logs_enabled || !settings.server_log_channel_id) return;

  const channel = guild.channels.cache.get(settings.server_log_channel_id);
  if (!channel || !channel.isTextBased()) {
    console.warn(`Server audit log channel is unavailable in ${guild.name}.`);
    return;
  }

  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.warn(`Could not post a server audit log in ${guild.name}:`, error.message);
  }
}

function auditChangeValue(value) {
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return value.map(auditChangeValue).join(", ").slice(0, 500) || "None";
  if (typeof value === "object") {
    const label = value.name || value.username || value.id;
    if (label) return String(label).slice(0, 500);
    try {
      return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item).slice(0, 500);
    } catch (error) {
      console.warn("Could not format an audit log change:", error.message);
      return "[Unserializable change]";
    }
  }
  return safeText(String(value)).slice(0, 500);
}

function auditActionLabel(action) {
  const labels = {
    [AuditLogEvent.GuildUpdate]: "Server Updated",
    [AuditLogEvent.ChannelCreate]: "Channel Created",
    [AuditLogEvent.ChannelUpdate]: "Channel Updated",
    [AuditLogEvent.ChannelDelete]: "Channel Deleted",
    [AuditLogEvent.ChannelOverwriteCreate]: "Channel Permission Overwrite Created",
    [AuditLogEvent.ChannelOverwriteUpdate]: "Channel Permissions Updated",
    [AuditLogEvent.ChannelOverwriteDelete]: "Channel Permission Overwrite Deleted",
    [AuditLogEvent.MemberKick]: "Member Kicked",
    [AuditLogEvent.MemberPrune]: "Members Pruned",
    [AuditLogEvent.MemberBanAdd]: "Member Banned",
    [AuditLogEvent.MemberBanRemove]: "Member Unbanned",
    [AuditLogEvent.MemberMove]: "Members Moved in Voice",
    [AuditLogEvent.MemberDisconnect]: "Member Disconnected from Voice",
    [AuditLogEvent.BotAdd]: "Bot Added",
    [AuditLogEvent.RoleCreate]: "Role Created",
    [AuditLogEvent.RoleUpdate]: "Role Updated",
    [AuditLogEvent.RoleDelete]: "Role Deleted",
    [AuditLogEvent.InviteCreate]: "Invite Created",
    [AuditLogEvent.InviteUpdate]: "Invite Updated",
    [AuditLogEvent.InviteDelete]: "Invite Deleted",
    [AuditLogEvent.WebhookCreate]: "Webhook Created",
    [AuditLogEvent.WebhookUpdate]: "Webhook Updated",
    [AuditLogEvent.WebhookDelete]: "Webhook Deleted",
    [AuditLogEvent.EmojiCreate]: "Emoji Created",
    [AuditLogEvent.EmojiUpdate]: "Emoji Updated",
    [AuditLogEvent.EmojiDelete]: "Emoji Deleted",
    [AuditLogEvent.MessageDelete]: "Message Deleted",
    [AuditLogEvent.MessageBulkDelete]: "Messages Bulk Deleted",
    [AuditLogEvent.MessagePin]: "Message Pinned",
    [AuditLogEvent.MessageUnpin]: "Message Unpinned",
    [AuditLogEvent.ApplicationCommandPermissionUpdate]: "Application Command Permissions Updated",
    [AuditLogEvent.IntegrationCreate]: "Integration Created",
    [AuditLogEvent.IntegrationUpdate]: "Integration Updated",
    [AuditLogEvent.IntegrationDelete]: "Integration Deleted",
    [AuditLogEvent.StageInstanceCreate]: "Stage Created",
    [AuditLogEvent.StageInstanceUpdate]: "Stage Updated",
    [AuditLogEvent.StageInstanceDelete]: "Stage Deleted",
    [AuditLogEvent.StickerCreate]: "Sticker Created",
    [AuditLogEvent.StickerUpdate]: "Sticker Updated",
    [AuditLogEvent.StickerDelete]: "Sticker Deleted",
    [AuditLogEvent.GuildScheduledEventCreate]: "Scheduled Event Created",
    [AuditLogEvent.GuildScheduledEventUpdate]: "Scheduled Event Updated",
    [AuditLogEvent.GuildScheduledEventDelete]: "Scheduled Event Deleted",
    [AuditLogEvent.ThreadCreate]: "Thread Created",
    [AuditLogEvent.ThreadUpdate]: "Thread Updated",
    [AuditLogEvent.ThreadDelete]: "Thread Deleted",
    [AuditLogEvent.SoundboardSoundCreate]: "Soundboard Sound Created",
    [AuditLogEvent.SoundboardSoundUpdate]: "Soundboard Sound Updated",
    [AuditLogEvent.SoundboardSoundDelete]: "Soundboard Sound Deleted",
    [AuditLogEvent.AutoModerationRuleCreate]: "AutoMod Rule Created",
    [AuditLogEvent.AutoModerationRuleUpdate]: "AutoMod Rule Updated",
    [AuditLogEvent.AutoModerationRuleDelete]: "AutoMod Rule Deleted",
    [AuditLogEvent.AutoModerationBlockMessage]: "AutoMod Blocked a Message",
    [AuditLogEvent.AutoModerationFlagToChannel]: "AutoMod Flagged a Message",
    [AuditLogEvent.AutoModerationUserCommunicationDisabled]: "AutoMod Timed Out a Member",
    [AuditLogEvent.AutoModerationQuarantineUser]: "AutoMod Quarantined a Member",
    [AuditLogEvent.CreatorMonetizationRequestCreated]: "Creator Monetization Request Created",
    [AuditLogEvent.CreatorMonetizationTermsAccepted]: "Creator Monetization Terms Accepted",
    [AuditLogEvent.OnboardingPromptCreate]: "Onboarding Prompt Created",
    [AuditLogEvent.OnboardingPromptUpdate]: "Onboarding Prompt Updated",
    [AuditLogEvent.OnboardingPromptDelete]: "Onboarding Prompt Deleted",
    [AuditLogEvent.OnboardingCreate]: "Onboarding Created",
    [AuditLogEvent.OnboardingUpdate]: "Onboarding Updated",
    [AuditLogEvent.HomeSettingsCreate]: "Server Home Settings Created",
    [AuditLogEvent.HomeSettingsUpdate]: "Server Home Settings Updated",
    [AuditLogEvent.VoiceChannelStatusCreate]: "Voice Channel Status Created",
    [AuditLogEvent.VoiceChannelStatusDelete]: "Voice Channel Status Deleted"
  };
  const name = AuditLogEvent[action];
  const fallback = name ? name.replace(/([a-z])([A-Z])/g, "$1 $2") : `Server Action ${action}`;
  return labels[action] || fallback;
}

function serverAuditEntryEmbed(entry) {
  const action = entry.action;
  const label = auditActionLabel(action);
  const targetId = entry.targetId || entry.target?.id;
  const targetName = entry.target?.name || entry.target?.username || entry.target?.tag;
  let target = targetName ? `**${safeText(targetName)}**` : "Unknown";
  if (targetId && USER_AUDIT_ACTIONS.has(action)) target = `${userMention(targetId)}${targetName ? ` (${safeText(targetName)})` : ""}`;
  else if (targetId && [AuditLogEvent.RoleCreate, AuditLogEvent.RoleUpdate, AuditLogEvent.RoleDelete].includes(action)) target = `${roleMention(targetId)}${targetName ? ` (${safeText(targetName)})` : ""}`;
  else if (targetId && [
    AuditLogEvent.ChannelCreate,
    AuditLogEvent.ChannelUpdate,
    AuditLogEvent.ChannelDelete,
    AuditLogEvent.ChannelOverwriteCreate,
    AuditLogEvent.ChannelOverwriteUpdate,
    AuditLogEvent.ChannelOverwriteDelete
  ].includes(action)) target = `${channelMention(targetId)}${targetName ? ` (${safeText(targetName)})` : ""}`;
  else if (targetId) target += ` (ID: ${targetId})`;

  const details = [
    { name: "Target", value: target, inline: false }
  ];
  if (entry.extra?.channel?.id) {
    details.push({ name: "Channel", value: channelMention(entry.extra.channel.id), inline: true });
  }
  if (Number.isFinite(entry.extra?.count)) {
    details.push({ name: "Count", value: String(entry.extra.count), inline: true });
  }
  for (const change of (entry.changes || []).slice(0, 4)) {
    const key = safeText(String(change.key).replace(/[_$]/g, " ").trim()).slice(0, 256);
    details.push({
      name: key || "Change",
      value: `Before: ${auditChangeValue(change.old).slice(0, 400)}\nAfter: ${auditChangeValue(change.new).slice(0, 400)}`,
      inline: false
    });
  }
  if (entry.reason) details.push({ name: "Reason", value: safeText(entry.reason), inline: false });
  details.push(
    { name: "Moderator", value: entry.executorId ? userMention(entry.executorId) : "Unknown", inline: true },
    { name: "Audit Entry", value: `ID: ${entry.id} • ${timestamp(entry.createdTimestamp)}`, inline: true }
  );

  let color = 0x3498DB;
  if (/Deleted|Kicked|Banned|Blocked|Timed Out|Quarantined|Disconnected|Pruned/.test(label)) color = 0xED4245;
  else if (/Created|Unbanned|Unpinned/.test(label)) color = 0x57F287;
  return publicEmbed(`📋 ${label}`, "A server audit-log action was recorded.", color).addFields(details);
}

async function logServerAuditEntry(entry, guild) {
  if (!SERVER_AUDIT_ACTIONS.has(entry.action)) return;
  const settings = getSettings(guild.id);
  if (!settings.server_logs_enabled || !settings.server_log_channel_id) return;

  await sendServerAuditLog(guild, serverAuditEntryEmbed(entry));
}

function canActivateSecurityCommand(guild, member) {
  if (!guild || !member) return false;
  if (member.id === guild.ownerId) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

  const botMember = guild.members.me;
  if (!botMember?.roles?.highest) return false;
  if (!member.roles?.highest) return false;

  return member.roles.highest.comparePositionTo(botMember.roles.highest) > 0;
}

function canModerateMember(guild, moderator, target) {
  if (!guild || !moderator || !target) return false;
  if (moderator.id === guild.ownerId) return true;
  if (!moderator.roles?.highest || !target.roles?.highest) return false;

  return target.roles.highest.comparePositionTo(moderator.roles.highest) < 0;
}

const HIGH_RISK_PERMISSION_MASK = HIGH_RISK_ROLE_PERMISSIONS.reduce((mask, permission) => mask | permission, 0n);

function roleHasHighRiskPermissions(role) {
  return (role.permissions.bitfield & HIGH_RISK_PERMISSION_MASK) !== 0n;
}

function isCriticalAuditEntry(guild, entry) {
  if (CRITICAL_AUDIT_ACTIONS.has(entry.action)) return true;

  const changes = entry.changes || [];
  if (entry.action === AuditLogEvent.RoleUpdate) {
    const permissionChange = changes.find(change => change.key === "permissions");
    if (!permissionChange) return false;

    try {
      const oldPermissions = BigInt(permissionChange.old || "0");
      const newPermissions = BigInt(permissionChange.new || "0");
      return ((newPermissions & HIGH_RISK_PERMISSION_MASK) & ~(oldPermissions & HIGH_RISK_PERMISSION_MASK)) !== 0n;
    } catch {
      return false;
    }
  }

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const addedRoles = changes.find(change => change.key === "$add")?.new;
    return Array.isArray(addedRoles) && addedRoles.some(roleInfo => {
      const role = guild.roles.cache.get(roleInfo.id);
      return role && roleHasHighRiskPermissions(role);
    });
  }

  return false;
}

function isAntiNukeWhitelisted(guildId, userId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM anti_nuke_whitelist
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId));
}

async function sendSecurityAlert(guild, description) {
  const embed = publicEmbed("🛡️ Security Protection Triggered", description, 0xED4245);

  if (guild.systemChannel?.isTextBased()) {
    try {
      await guild.systemChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    } catch (error) {
      console.warn(`Could not post a security alert in ${guild.name}'s system channel:`, error.message);
    }
  }

  try {
    const owner = await guild.fetchOwner();
    await owner.send({ embeds: [embed] });
  } catch (error) {
    console.warn(`Could not DM ${guild.name}'s owner about a security event:`, error.message);
  }
}

async function notifyGuildAdministrators(guild, description) {
  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    console.warn(`Could not fetch all members to send an anti-nuke alert in ${guild.name}:`, error.message);
    members = guild.members.cache;
  }

  const administrators = members.filter(member =>
    member.id !== client.user.id && member.permissions.has(PermissionFlagsBits.Administrator)
  );
  const embed = publicEmbed("🚨 Anti-Nuke Alert", description, 0xED4245);
  const results = await Promise.allSettled(
    administrators.map(member => member.send({ embeds: [embed] }))
  );

  return {
    adminCount: administrators.size,
    dmCount: results.filter(result => result.status === "fulfilled").length
  };
}

async function applyRaidTimeout(member) {
  if (member.user.bot || member.permissions.has(PermissionFlagsBits.Administrator) || !member.moderatable) return false;

  try {
    await member.timeout(SECURITY_LIMITS.raidTimeoutMs, "Automatic anti-raid protection");
    return true;
  } catch (error) {
    console.warn(`Could not apply anti-raid timeout to ${member.user.tag}:`, error.message);
    return false;
  }
}

async function handleRaidJoin(member) {
  const guildId = member.guild.id;
  const currentTime = Date.now();
  const recentJoins = (recentJoinWindows.get(guildId) || [])
    .filter(join => currentTime - join.joinedAt <= SECURITY_LIMITS.raidWindowMs);
  recentJoins.push({ member, joinedAt: currentTime });
  recentJoinWindows.set(guildId, recentJoins);

  const raidIsActive = (raidProtectionUntil.get(guildId) || 0) > currentTime;
  if (!raidIsActive && recentJoins.length < SECURITY_LIMITS.raidJoinCount) return;

  raidProtectionUntil.set(guildId, currentTime + SECURITY_LIMITS.raidTimeoutMs);
  const membersToTimeout = raidIsActive ? [member] : recentJoins.map(join => join.member);
  let timedOutCount = 0;

  for (const joiningMember of membersToTimeout) {
    if (await applyRaidTimeout(joiningMember)) timedOutCount += 1;
  }

  if (!raidIsActive) {
    await sendSecurityAlert(member.guild, `A join burst triggered raid protection. ${timedOutCount} recent member(s) were timed out for 24 hours.`);
  }
}

async function handleAntiNukeAuditEntry(entry, guild) {
  const executorId = entry.executorId;
  if (!executorId || executorId === client.user.id || executorId === guild.ownerId) return;
  if (isAntiNukeWhitelisted(guild.id, executorId)) return;

  const currentTime = Date.now();
  const windowKey = `${guild.id}:${executorId}`;

  if (entry.action === AuditLogEvent.ChannelDelete) {
    const state = channelDeleteWindows.get(windowKey) || { timestamps: [], triggered: false };
    state.timestamps = state.timestamps.filter(time => currentTime - time <= SECURITY_LIMITS.channelDeleteWindowMs);
    if (!state.timestamps.length) state.triggered = false;
    state.timestamps.push(currentTime);
    channelDeleteWindows.set(windowKey, state);

    if (state.triggered || state.timestamps.length < SECURITY_LIMITS.channelDeleteCount) return;
    state.triggered = true;

    const executor = await guild.members.fetch(executorId).catch(() => null);
    let alert;
    if (!executor) {
      alert = `A member deleted at least ${SECURITY_LIMITS.channelDeleteCount} channels within 10 seconds, but I could not find them in the server to blacklist.`;
    } else {
      const result = await doBlacklist(
        guild,
        guild.members.me,
        executor,
        "❌ Unappealable",
        `Automatic anti-nuke protection: deleted at least ${SECURITY_LIMITS.channelDeleteCount} channels within 10 seconds.`,
        { allowAdministrator: true }
      );

      const outcome = result.error ? `I could not blacklist them: ${result.error}` : "They were automatically blacklisted.";
      alert = `${userMention(executorId)} deleted at least ${SECURITY_LIMITS.channelDeleteCount} channels within 10 seconds. ${outcome}`;

      if (!result.error) {
        const settings = getSettings(guild.id);
        const logChannel = guild.channels.cache.get(settings.blacklist_channel_id);
        if (logChannel?.isTextBased()) await logChannel.send({ embeds: [result.embed] }).catch(() => {});
      }
    }

    const delivery = await notifyGuildAdministrators(guild, `${guild.name}: ${alert}`);
    await sendSecurityAlert(guild, `${alert} Admin DMs delivered: ${delivery.dmCount}/${delivery.adminCount}.`);

    return;
  }

  if (!isCriticalAuditEntry(guild, entry)) return;

  const state = nukeActionWindows.get(windowKey) || { timestamps: [], triggered: false };
  state.timestamps = state.timestamps.filter(time => currentTime - time <= SECURITY_LIMITS.nukeWindowMs);
  if (!state.timestamps.length) state.triggered = false;
  state.timestamps.push(currentTime);
  nukeActionWindows.set(windowKey, state);

  if (state.triggered || state.timestamps.length < SECURITY_LIMITS.nukeActionCount) return;
  state.triggered = true;

  const executor = await guild.members.fetch(executorId).catch(() => null);
  const botMember = guild.members.me;
  let removedRoles = 0;

  if (executor?.manageable && botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    const dangerousRoles = executor.roles.cache.filter(role =>
      role.id !== guild.id && role.editable && roleHasHighRiskPermissions(role)
    );

    if (dangerousRoles.size) {
      try {
        await executor.roles.remove(dangerousRoles, "Automatic anti-nuke protection");
        removedRoles = dangerousRoles.size;
      } catch (error) {
        console.warn(`Could not remove high-risk roles from ${executor.user.tag}:`, error.message);
      }
    }
  }

  const mitigation = removedRoles ? `Removed ${removedRoles} high-risk role(s).` : "I could not remove any high-risk roles; check my Manage Roles permission and role hierarchy.";
  await sendSecurityAlert(guild, `${userMention(executorId)} performed ${state.timestamps.length} critical server actions within 10 seconds. ${mitigation}`);
}

async function doBlacklist(guild, moderator, target, category, reason, options = {}) {
  if (!target) return { error: "User not found." };
  if (target.id === moderator.id) return { error: "You cannot blacklist yourself." };
  if (!options.allowAdministrator && target.permissions.has(PermissionFlagsBits.Administrator)) return { error: "This person has administrator permission." };

  const botMember = guild.members.me;
  if (!botMember) return { error: "I could not determine my role position in this server." };
  if (!target.roles?.highest || !botMember.roles?.highest) {
    return { error: "I could not determine the role hierarchy for this user." };
  }

  if (target.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
    return { error: "This person is at or above the bot in the hierarchy, so I cannot blacklist them." };
  }

  if (!moderator.roles?.highest) {
    return { error: "I could not determine your role hierarchy." };
  }

  if (target.roles.highest.comparePositionTo(moderator.roles.highest) >= 0) {
    return { error: "This person is at or above you in the hierarchy." };
  }
  if (!target.manageable) return { error: "I cannot manage this user. Move my bot role above their highest role." };

  const blacklistRole = guild.roles.cache.find(role => role.name === BLACKLIST_ROLE_NAME);

  if (!blacklistRole) return { error: `The \`${BLACKLIST_ROLE_NAME}\` role does not exist.` };
  if (!blacklistRole.editable) return { error: "I cannot manage the Blacklisted role. Move my bot role above it." };

  const savedRoles = target.roles.cache
    .filter(role => role.id !== guild.id && !role.managed)
    .map(role => role.id);

  const removableRoles = savedRoles
    .map(roleId => guild.roles.cache.get(roleId))
    .filter(role => role && role.editable);

  try {
    if (removableRoles.length) {
      await target.roles.remove(removableRoles);
    }

    await target.roles.add(blacklistRole);
  } catch (error) {
    console.error("Blacklist role assignment failed:", error);
    return { error: "I couldn't change that user's roles. Check that I have Manage Roles permission and my bot role is above the user's roles." };
  }

  const createdAt = now();

  const insertBlacklistRecord = db.transaction(() => {
    const caseNumber = db.prepare(`
      SELECT COALESCE(MAX(case_number), 0) + 1 AS case_number
      FROM blacklist_records
      WHERE guild_id = ?
    `).get(guild.id).case_number;
    db.prepare(`
      INSERT INTO blacklist_records (case_number, guild_id, user_id, moderator_id, category, reason, roles_json, roles_count, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(caseNumber, guild.id, target.id, moderator.id, category, reason, JSON.stringify(savedRoles), savedRoles.length, createdAt);
    return caseNumber;
  });
  const caseNumber = insertBlacklistRecord();

  addModLog(guild.id, "blacklist", target.id, moderator.id, reason);

  const settings = getSettings(guild.id);
  const appealText = settings.appeal_link ? `\n\nTo appeal, join here: ${settings.appeal_link}` : "";

  const embed = publicEmbed("⛔ User Blacklisted", `${userMention(target.id)} has been blacklisted.`, 0xED4245).addFields(
    { name: "👤 User", value: userMention(target.id), inline: true },
    { name: "👮 Responsible Moderator", value: userMention(moderator.id), inline: true },
    { name: "📂 Category", value: category, inline: true },
    { name: "📘 Case", value: `#${caseNumber}`, inline: true },
    { name: "📝 Reason", value: safeText(reason), inline: false },
    { name: "🎭 Roles Stored", value: String(savedRoles.length), inline: true },
    { name: "📅 Date", value: timestamp(createdAt), inline: true }
  );

  let dmStatus = "❌ Failed";

  try {
    await target.send({
      embeds: [publicEmbed("⛔ You Have Been Blacklisted", `You have been blacklisted in **${guild.name}**.\n\n**Category:** ${category}\n**Reason:** ${safeText(reason)}${appealText}`, 0xED4245)]
    });
    dmStatus = "✅ Sent";
  } catch {
    dmStatus = "❌ Failed";
  }

  embed.addFields({ name: "📩 DM Status", value: dmStatus, inline: true });

  return { embed };
}

function blacklistCaseEmbed(record, title = `📘 Blacklist Case #${record.case_number}`, description = "Blacklist case details") {
  return publicEmbed(title, description, 0x5865F2).addFields(
    { name: "Action", value: "BLACKLIST", inline: true },
    { name: "Status", value: record.active ? "Active" : "Inactive", inline: true },
    { name: "User", value: userMention(record.user_id), inline: true },
    { name: "Moderator", value: userMention(record.moderator_id), inline: true },
    { name: "Category", value: safeText(record.category).slice(0, 1024), inline: true },
    { name: "Reason", value: safeText(record.reason || "No reason provided").slice(0, 1024) },
    { name: "Date", value: timestamp(record.created_at), inline: true }
  );
}

async function doUnblacklist(guild, moderator, target, reason) {
  const record = db.prepare(`
    SELECT *
    FROM blacklist_records
    WHERE guild_id = ?
    AND user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(guild.id, target.id);

  const blacklistRole = guild.roles.cache.find(role => role.name === BLACKLIST_ROLE_NAME);
  const hasBlacklistedRole = Boolean(blacklistRole && target.roles.cache.has(blacklistRole.id));

  if (!record || (!record.active && !hasBlacklistedRole)) {
    return { error: `${userMention(target.id)} is not currently blacklisted.` };
  }

  let savedRoles = [];
  try {
    savedRoles = JSON.parse(record.roles_json || "[]");
  } catch {
    savedRoles = [];
  }

  const blockedRoles = [];

  for (const roleId of savedRoles) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    if (!role.editable) blockedRoles.push(role.name);
  }

  if (blockedRoles.length) {
    return {
      error: "❌ I cannot restore these roles because they are above my bot role:\n\n" + blockedRoles.map(name => `• ${name}`).join("\n")
    };
  }

  if (blacklistRole && target.roles.cache.has(blacklistRole.id)) {
    await target.roles.remove(blacklistRole).catch(() => {});
  }

  const restoredRoles = [];
  const missingRoles = [];

  for (const roleId of savedRoles) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      missingRoles.push(roleId);
      continue;
    }

    try {
      await target.roles.add(role);
      restoredRoles.push(role.name);
    } catch {
      return { error: `❌ I could not restore the role **${role.name}**. The blacklist was NOT marked inactive.` };
    }
  }

  db.prepare(`
    UPDATE blacklist_records
    SET active = 0
    WHERE id = ?
  `).run(record.id);

  addModLog(guild.id, "unblacklist", target.id, moderator.id, reason);

  const embed = publicEmbed("✅ User Unblacklisted", `${userMention(target.id)} has been unblacklisted successfully.`, 0x57F287).addFields(
    { name: "👤 User", value: userMention(target.id), inline: true },
    { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
    { name: "🎭 Roles Restored", value: String(restoredRoles.length), inline: true },
    { name: "📂 Original Category", value: record.category, inline: true },
    { name: "📝 Original Reason", value: safeText(record.reason), inline: false },
    { name: "📝 Unblacklist Reason", value: safeText(reason), inline: false },
    { name: "📅 Original Date", value: timestamp(record.created_at), inline: true }
  );

  if (missingRoles.length) {
    embed.addFields({ name: "⚠️ Roles No Longer In Server", value: `${missingRoles.length} saved role(s) no longer exist.` });
  }

  return { embed };
}

function blacklistListEmbed(guildId, page = 1) {
  const records = db.prepare(`
    SELECT id, user_id, moderator_id, category, reason, created_at
    FROM blacklist_records
    WHERE guild_id = ? AND active = 1
    ORDER BY id DESC
  `).all(guildId);

  const uniqueRecords = [...new Map(records.map(record => [record.user_id, record])).values()];
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(uniqueRecords.length / pageSize));

  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    return { error: `There are ${pageCount} page(s) of active blacklists.` };
  }

  const pageRecords = uniqueRecords.slice((page - 1) * pageSize, page * pageSize);
  const embed = publicEmbed(
    "⛔ Current Blacklist",
    `**${uniqueRecords.length}** currently blacklisted member(s)`,
    0xED4245
  );

  const controls = createBlacklistListControls(page, pageCount);
  const moderatorIds = [...new Set(pageRecords.map(record => record.moderator_id))];
  const mentionContent = moderatorIds.length
    ? `Moderator ping: ${moderatorIds.map(userMention).join(" ")}`
    : null;

  if (!pageRecords.length) {
    embed.setDescription("No members are currently blacklisted.");
    return { embed, components: [controls], moderatorIds, mentionContent };
  }

  for (const [index, record] of pageRecords.entries()) {
    const reason = safeText(record.reason).slice(0, 300);
    embed.addFields({
      name: `${(page - 1) * pageSize + index + 1}. ${userMention(record.user_id)} · ${safeText(record.category)}`,
      value: `${reason}\nModerator: ${userMention(record.moderator_id)} · ${timestamp(record.created_at)}`,
      inline: true
    });
  }

  return { embed, components: [controls], moderatorIds, mentionContent };
}

function createBlacklistListControls(page, pageCount) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("blacklistlist_page:first:1")
      .setLabel("⏮ First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`blacklistlist_page:prev:${Math.max(1, page - 1)}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`blacklistlist_page:current:${page}`)
      .setLabel(`Page ${page}/${pageCount}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`blacklistlist_page:next:${Math.min(pageCount, page + 1)}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount),
    new ButtonBuilder()
      .setCustomId(`blacklistlist_page:last:${pageCount}`)
      .setLabel("Last ⏭")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount)
  );
}

function parseDuration(duration) {
  const match = /^(\d+)(s|m|h|d)$/i.exec(duration);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

  return amount * multipliers[unit];
}

async function doMute(guild, moderator, target, duration, reason) {
  if (!target) return { error: "User not found." };
  if (!canModerateMember(guild, moderator, target)) return { error: "This person is higher than you in the hierarchy." };

  const ms = parseDuration(duration);
  const finalReason = reason || "No reason provided";

  if (!ms) return { error: "Invalid duration. Use `10m`, `1h`, `1d`, etc." };
  if (ms > 28 * 86400000) return { error: "Discord only allows timeouts up to 28 days." };
  if (!target.moderatable) return { error: "I cannot timeout this user. Check my role hierarchy." };

  try {
    await target.timeout(ms, finalReason);
  } catch (error) {
    console.error("Mute failed:", error);
    return { error: "I couldn't mute that user. Check my Timeout Members permission and role hierarchy." };
  }

  addModLog(guild.id, "mute", target.id, moderator.id, finalReason);

  return {
    embed: publicEmbed("🔇 User Muted", `${userMention(target.id)} has been muted.`, 0x5865F2).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "⏱️ Duration", value: duration, inline: true },
      { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
      { name: "📝 Reason", value: safeText(finalReason) }
    )
  };
}

async function doUnmute(guild, moderator, target, reason) {
  if (!target) return { error: "User not found." };
  if (!target.communicationDisabledUntilTimestamp) return { error: `${userMention(target.id)} is not currently muted.` };

  try {
    await target.timeout(null, reason);
  } catch (error) {
    console.error("Unmute failed:", error);
    return { error: "I couldn't unmute that user. Check my Timeout Members permission and role hierarchy." };
  }

  addModLog(guild.id, "unmute", target.id, moderator.id, reason);

  return {
    embed: publicEmbed("🔊 User Unmuted", `${userMention(target.id)} has been unmuted.`, 0x57F287).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
      { name: "📝 Reason", value: safeText(reason), inline: false }
    )
  };
}

async function doAddRole(guild, moderator, target, role, reason) {
  if (!target) return { error: "User not found." };
  if (!role) return { error: "Role not found." };
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return { error: "I need the Manage Roles permission." };
  if (!role.editable || role.comparePositionTo(botMember.roles.highest) >= 0) return { error: "I can't manage that role because it's above or equal to my top role." };
  if (!canModerateMember(guild, moderator, target)) return { error: "This person is higher than you in the hierarchy." };

  if (target.roles.cache.has(role.id)) {
    return { embed: publicEmbed("🎭 Role Already Present", `${userMention(target.id)} already has ${role}.`, 0x57F287) };
  }

  try {
    await target.roles.add(role, reason || "Role added by moderator");
  } catch (error) {
    console.error("AddRole failed:", error);
    return { error: "I couldn't add that role. Check my role hierarchy and Manage Roles permission." };
  }

  addModLog(guild.id, "addrole", target.id, moderator.id, `${role.name} | ${reason || "No reason provided"}`);

  return {
    embed: publicEmbed("🎭 Role Added", `${userMention(target.id)} was given ${role}.`, 0x57F287).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "🎭 Role", value: role.name, inline: true },
      { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
      { name: "📝 Reason", value: safeText(reason || "No reason provided") }
    )
  };
}

async function doRemoveRole(guild, moderator, target, role, reason) {
  if (!target) return { error: "User not found." };
  if (!role) return { error: "Role not found." };
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return { error: "I need the Manage Roles permission." };
  if (!role.editable || role.comparePositionTo(botMember.roles.highest) >= 0) return { error: "I can't manage that role because it's above or equal to my top role." };
  if (!canModerateMember(guild, moderator, target)) return { error: "This person is higher than you in the hierarchy." };

  if (!target.roles.cache.has(role.id)) {
    return { embed: publicEmbed("🎭 Role Not Present", `${userMention(target.id)} does not have ${role}.`, 0x57F287) };
  }

  try {
    await target.roles.remove(role, reason || "Role removed by moderator");
  } catch (error) {
    console.error("RemoveRole failed:", error);
    return { error: "I couldn't remove that role. Check my role hierarchy and Manage Roles permission." };
  }

  addModLog(guild.id, "removerole", target.id, moderator.id, `${role.name} | ${reason || "No reason provided"}`);

  return {
    embed: publicEmbed("🎭 Role Removed", `${userMention(target.id)} lost ${role}.`, 0xED4245).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "🎭 Role", value: role.name, inline: true },
      { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
      { name: "📝 Reason", value: safeText(reason || "No reason provided") }
    )
  };
}

async function doTempRole(guild, moderator, target, role, duration, reason) {
  if (!target) return { error: "User not found." };
  if (!role) return { error: "Role not found." };
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return { error: "I need the Manage Roles permission." };
  if (!role.editable || role.comparePositionTo(botMember.roles.highest) >= 0) return { error: "I can't manage that role because it's above or equal to my top role." };
  if (!canModerateMember(guild, moderator, target)) return { error: "This person is higher than you in the hierarchy." };

  const ms = parseDuration(duration);
  if (!ms) return { error: "Invalid duration. Use `10m`, `1h`, `1d`, etc." };
  if (ms > 28 * 86400000) return { error: "Discord only allows timeouts up to 28 days." };

  try {
    await target.roles.add(role, reason || "Temporary role granted by moderator");
  } catch (error) {
    console.error("TempRole add failed:", error);
    return { error: "I couldn't grant the temporary role. Check my role hierarchy and Manage Roles permission." };
  }

  setTimeout(async () => {
    try {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "Temporary role expired");
      }
    } catch (error) {
      console.warn(`Temp role removal failed for ${target.id}:`, error.message);
    }
  }, ms);

  addModLog(guild.id, "temprole", target.id, moderator.id, `${role.name} | ${duration} | ${reason || "No reason provided"}`);

  return {
    embed: publicEmbed("🕒 Temporary Role Added", `${userMention(target.id)} was granted ${role} for ${duration}.`, 0x5865F2).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "🎭 Role", value: role.name, inline: true },
      { name: "⏱️ Duration", value: duration, inline: true },
      { name: "👮 Moderator", value: userMention(moderator.id), inline: true },
      { name: "📝 Reason", value: safeText(reason || "No reason provided") }
    )
  };
}

function getActionCounts(guildId, moderatorId, since = null) {
  const query = `
    SELECT action, COUNT(*) AS count
    FROM moderation
    WHERE guild_id = ?
    AND moderator_id = ?
    ${since ? "AND created_at >= ?" : ""}
    AND action IN ('blacklist', 'warn', 'mute')
    GROUP BY action
  `;

  const params = since ? [guildId, moderatorId, since] : [guildId, moderatorId];
  const rows = db.prepare(query).all(...params);
  const counts = { blacklist: 0, warn: 0, mute: 0 };

  for (const row of rows) {
    if (row.action === "blacklist") counts.blacklist = Number(row.count || 0);
    if (row.action === "warn") counts.warn = Number(row.count || 0);
    if (row.action === "mute") counts.mute = Number(row.count || 0);
  }

  return counts;
}

function formatActionCounts(counts) {
  return [
    `Blacklist: ${counts.blacklist}`,
    `Warns: ${counts.warn}`,
    `Mute: ${counts.mute}`
  ].join("\n");
}

function modlogsEmbed(guildId, moderatorId) {
  const current = now();
  const last7Ms = current - 7 * 86400000;
  const last30Ms = current - 30 * 86400000;

  const last7 = getActionCounts(guildId, moderatorId, last7Ms);
  const last30 = getActionCounts(guildId, moderatorId, last30Ms);
  const allTime = getActionCounts(guildId, moderatorId);

  const embed = publicEmbed("📊 Moderator Logs", `Moderation activity for ${userMention(moderatorId)}.`, 0x5865F2).addFields(
    { name: "📅 Last 7 Days", value: formatActionCounts(last7), inline: false },
    { name: "📆 Last 30 Days", value: formatActionCounts(last30), inline: false },
    { name: "📚 All Time", value: formatActionCounts(allTime), inline: false }
  );

  return embed;
}

function getWarningId(guildId, userId, moderatorId, createdAt) {
  const warning = db.prepare(`
    SELECT id
    FROM warnings
    WHERE guild_id = ?
    AND user_id = ?
    AND moderator_id = ?
    AND ABS(created_at - ?) <= 5000
    ORDER BY ABS(created_at - ?) ASC
    LIMIT 1
  `).get(guildId, userId, moderatorId, createdAt, createdAt);

  return warning ? warning.id : null;
}

function serverInfoEmbed(guild) {
  if (!guild) return publicEmbed("📡 Server Info", "This command can only be used in a server.", 0xED4245);

  const memberCount = guild.memberCount || guild.members.cache.size || 0;
  const humanCount = guild.members.cache.filter(member => !member.user.bot).size;
  const botCount = guild.members.cache.filter(member => member.user.bot).size;
  const roleCount = guild.roles.cache.size;
  const channelCount = guild.channels.cache.size;
  const iconUrl = guild.iconURL({ dynamic: true, size: 256 }) || null;

  const embed = publicEmbed(
    `📡 ${guild.name}`,
    "Server overview and details.",
    0x5865F2
  );

  if (iconUrl) {
    embed.setThumbnail(iconUrl);
  }

  embed.addFields(
    { name: "🆔 Server ID", value: String(guild.id), inline: true },
    { name: "👑 Owner", value: guild.ownerId ? userMention(guild.ownerId) : "Unknown", inline: true },
    { name: "📅 Created", value: timestamp(guild.createdAt.getTime()), inline: true },
    { name: "👥 Members", value: String(memberCount), inline: true },
    { name: "🧑 Humans", value: String(humanCount), inline: true },
    { name: "🤖 Bots", value: String(botCount), inline: true },
    { name: "🎭 Roles", value: String(roleCount), inline: true },
    { name: "#️⃣ Channels", value: String(channelCount), inline: true }
  );

  return embed;
}

function userInfoEmbed(member) {
  const user = member.user;
  const roles = member.roles.cache
    .filter(role => role.id !== member.guild.id)
    .sort((first, second) => second.position - first.position)
    .map(role => role.name);
  let roleList = roles.length ? roles.map(role => safeText(role)).join(", ") : "No roles";
  if (roleList.length > 1000) roleList = `${roleList.slice(0, 997)}...`;

  const embed = publicEmbed(`👤 User Info: ${safeText(user.username)}`, userMention(user.id), 0x5865F2)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "User ID", value: user.id, inline: true },
      { name: "Username", value: safeText(user.tag || user.username), inline: true },
      { name: "Nickname", value: member.nickname ? safeText(member.nickname) : "None", inline: true },
      { name: "Account Created", value: timestamp(user.createdAt.getTime()), inline: true },
      { name: "Joined Server", value: member.joinedAt ? timestamp(member.joinedAt.getTime()) : "Unknown", inline: true },
      { name: "Roles", value: roleList, inline: false }
    );

  if (member.communicationDisabledUntilTimestamp > Date.now()) {
    embed.addFields({ name: "Timeout Until", value: timestamp(member.communicationDisabledUntilTimestamp), inline: true });
  }

  return embed;
}

function staffStrikeEmbed(member, strikes) {
  const embed = publicEmbed(
    "⚠️ Staff Strike Record",
    `${userMention(member.id)} has **${strikes.length}/3** staff strikes.`,
    strikes.length >= 3 ? 0xED4245 : 0xFEE75C
  );

  if (!strikes.length) {
    embed.setDescription(`${userMention(member.id)} has **0/3** staff strikes.`);
    return embed;
  }

  for (const strike of strikes) {
    embed.addFields({
      name: `Strike #${strike.strike_number}`,
      value: `**Reason:** ${safeText(strike.reason)}\n**Given by:** ${userMention(strike.moderator_id)}\n**Date:** ${timestamp(strike.created_at)}`
    });
  }

  return embed;
}

function strikeDeleteSelection(guildId, userId) {
  const strikes = db.prepare(`
    SELECT id, moderator_id, reason, created_at
    FROM staff_strikes
    WHERE guild_id = ? AND user_id = ?
    ORDER BY id DESC
  `).all(guildId, userId);

  if (!strikes.length) {
    return {
      embed: publicEmbed("🗑️ Delete Staff Strike", `${userMention(userId)} has no staff strikes.`, 0x57F287),
      components: []
    };
  }

  const buttons = strikes.map(strike =>
    new ButtonBuilder()
      .setCustomId(`delete_strike:${strike.id}`)
      .setLabel(`Delete #${strike.id}`)
      .setStyle(ButtonStyle.Danger)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  const embed = publicEmbed(
    "🗑️ Delete Staff Strike",
    `Choose a strike to delete for ${userMention(userId)}.`,
    0xED4245
  ).addFields({ name: "⚠️ Strike Count", value: String(strikes.length), inline: true });

  for (const strike of strikes) {
    embed.addFields({
      name: `Strike #${strike.id}`,
      value: `**Reason:** ${safeText(strike.reason)}\n**Given by:** ${userMention(strike.moderator_id)}\n**Date:** ${timestamp(strike.created_at)}`
    });
  }

  return { embed, components: rows };
}

function staffStrikeListEmbed(guildId, page = 1) {
  const records = db.prepare(`
    SELECT user_id, COUNT(*) AS strike_count, MAX(created_at) AS latest_strike
    FROM staff_strikes
    WHERE guild_id = ?
    GROUP BY user_id
    ORDER BY strike_count DESC, latest_strike DESC, user_id ASC
  `).all(guildId);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    return { error: `There are ${pageCount} page(s) of staff strike records.` };
  }

  const pageRecords = records.slice((page - 1) * pageSize, page * pageSize);
  const embed = publicEmbed("⚠️ Staff Strike List", "Loading strike list...", 0xFEE75C);
  if (!pageRecords.length) {
    embed.setDescription("No staff strikes have been recorded.");
  } else {
    embed.setDescription(pageRecords.map(record =>
      `${userMention(record.user_id)} — **${Math.min(record.strike_count, 3)}/3**`
    ).join("\n"));
  }

  embed.setFooter({ text: `Page ${page}/${pageCount}` });
  return { embed, components: [createStaffStrikeListControls(page, pageCount)] };
}

function createStaffStrikeListControls(page, pageCount) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("strikelist_page:first:1").setLabel("⏮ First").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`strikelist_page:prev:${Math.max(1, page - 1)}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`strikelist_page:current:${page}`).setLabel(`Page ${page}/${pageCount}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`strikelist_page:next:${Math.min(pageCount, page + 1)}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount),
    new ButtonBuilder().setCustomId(`strikelist_page:last:${pageCount}`).setLabel("Last ⏭").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount)
  );
}

function helpEmbed() {
  return publicEmbed(
    "📘 JJS Bot Help",
    "Here is a full list of available commands and what they do.",
    0x5865F2
  ).addFields(
    {
      name: "General",
      value: [
        "**/help** — Shows this help menu.",
        "**/serverinfo** — Displays general information about this server.",
        "**/serverlogs** — Sets or checks the channel for server audit logs.",
        "**/userinfo** — Shows a member's profile, join date, account age, and roles.",
        "**/autoping** — Enables or disables join pings in a chosen channel.",
        "**/setup** — Opens the bot setup menu.",
        "**/logs** — Shows recent moderation and security events."
      ].join("\n"),
      inline: false
    },
    {
      name: "Moderation",
      value: [
        "**/warn** — Issues a warning to a user with a reason.",
        "**/warns** — Shows a user's warning history.",
        "**/deletewarns** — Deletes one of a user's warnings.",
        "**/kick** — Kicks a user from the server with a reason.",
        "**/mute** — Times out a user for a specified duration.",
        "**/unmute** — Removes a timeout from a user.",
        "**/modlogs** — Shows moderation activity for a moderator.",
        "**/purge** — Deletes up to 100 recent messages from this channel."
      ].join("\n"),
      inline: false
    },
    {
      name: "Strikes and blacklist",
      value: [
        "**/strike add** — Gives a staff member a strike, up to 3/3.",
        "**/strike delete** — Deletes one selected strike; requires a role above the bot.",
        "**/strikecheck** — Shows a staff member's strike history.",
        "**/strikelist** — Lists struck staff and their strike count.",
        "**/blacklist** — Blacklists a user and records the action.",
        "**/blacklistlist** — Lists currently blacklisted members.",
        "**/blacklistcheck** — Checks a user's blacklist status.",
        "**/unblacklist** — Removes a blacklist status and restores stored roles.",
        "**/case** — Shows a blacklist case by its number.",
        "**/editcase** — Edits the reason on a blacklist case."
      ].join("\n"),
      inline: false
    },
    {
      name: "Security",
      value: [
        "**/raid** — Manually enables or disables raid protection.",
        "**/whitelist** — Manages anti-nuke exemptions.",
        "**/honeypot** — Configures a monitored channel that removes messages and kicks non-admin posters.",
        "**/testsecuritydm** — Sends administrators a test DM."
      ].join("\n"),
      inline: false
    },
    {
      name: "Channels and roles",
      value: [
        "**/slowmode** — Sets or clears this channel's slowmode.",
        "**/lock** — Prevents @everyone from sending messages in this channel.",
        "**/unlock** — Restores @everyone's ability to send messages.",
        "**/addrole** — Adds a role to a user.",
        "**/removerole** — Removes a role from a user.",
        "**/temprole** — Adds a temporary role for a set duration."
      ].join("\n"),
      inline: false
    }
  );
}

function findRoleByName(guild, name) {
  if (!guild || !name) return null;

  const normalized = String(name).trim();
  if (!normalized) return null;

  const matches = guild.roles.cache.filter(role => role.name.toLowerCase() === normalized.toLowerCase());
  return matches.find(role => role.editable) || matches.first() || null;
}

function setupSummary(guildId) {
  const settings = getSettings(guildId);
  const prefixes = getPrefixes(guildId);
  const embed = publicEmbed("⚙️ JJS Bot Setup", settings.setup_complete ? "Setup is complete." : "Configure the bot using the buttons below.", 0x5865F2);

  embed.addFields({ name: "📢 Blacklist Channel", value: channelMention(settings.blacklist_channel_id), inline: true });
  embed.addFields({ name: "📢 Unblacklist Channel", value: channelMention(settings.unblacklist_channel_id), inline: true });
  embed.addFields({ name: "📜 Log Channel", value: channelMention(settings.log_channel_id), inline: true });
  const enabledLogLabels = LOG_EVENT_OPTIONS.filter(option => getEnabledLogEvents(settings).includes(option.value)).map(option => option.label);
  embed.addFields({ name: "Log Events", value: enabledLogLabels.length ? enabledLogLabels.join(", ") : "None", inline: false });
  embed.addFields({
    name: "🧾 Server Audit Logs",
    value: `${settings.server_logs_enabled ? "Enabled" : "Disabled"}\nChannel: ${channelMention(settings.server_log_channel_id)}`,
    inline: true
  });
  embed.addFields({ name: "📣 Auto Ping Channel", value: channelMention(settings.auto_ping_channel_id), inline: true });
  embed.addFields({ name: "📎 Appeal Link", value: settings.appeal_link ? String(settings.appeal_link).slice(0, 200) : "Not set", inline: false });
  embed.addFields({ name: "🔤 Enabled Prefixes", value: prefixes.length ? prefixes.map(p => `\`${p}\``).join(" ") : "None", inline: false });

  const commandGroups = [];
  for (let index = 0; index < COMMANDS.length; index += 8) {
    const lines = COMMANDS.slice(index, index + 8).map(command => {
      const roles = getCommandRoles(guildId, command);
      const roleList = roles.length
        ? `${roles.slice(0, 3).map(roleMention).join(" ")}${roles.length > 3 ? ` +${roles.length - 3}` : ""}`
        : "Administrators";
      return `/${command}: ${roleList}`;
    });
    commandGroups.push(lines.join("\n"));
  }
  commandGroups.forEach((value, index) => {
    embed.addFields({ name: `Command Roles ${index + 1}`, value, inline: false });
  });

  return embed;
}

function setupControls() {
  const splitIndex = Math.ceil(COMMANDS.length / 2);
  const commandMenus = [COMMANDS.slice(0, splitIndex), COMMANDS.slice(splitIndex)].map((commands, index) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`setup_command_select:${index + 1}`)
        .setPlaceholder(`🎮 Choose a command (${index + 1}/2)`)
        .addOptions(commands.map(command => ({ label: `/${command}`, value: command })))
    )
  );

  const channelsButton = new ButtonBuilder().setCustomId("setup_channels").setLabel("📢 Set Channels").setStyle(ButtonStyle.Primary);
  const prefixesButton = new ButtonBuilder().setCustomId("setup_prefixes").setLabel("🔤 Set Prefixes").setStyle(ButtonStyle.Primary);
  const autoPingButton = new ButtonBuilder().setCustomId("setup_auto_ping").setLabel("📣 Set Join Ping").setStyle(ButtonStyle.Primary);
  const logButton = new ButtonBuilder().setCustomId("setup_log_channel").setLabel("📜 Set Log Channel").setStyle(ButtonStyle.Primary);
  const appealButton = new ButtonBuilder().setCustomId("setup_appeal_link").setLabel("📎 Set Appeal Link").setStyle(ButtonStyle.Primary);
  const finishButton = new ButtonBuilder().setCustomId("setup_finish").setLabel("✅ Finish Setup").setStyle(ButtonStyle.Success);
  const resetButton = new ButtonBuilder().setCustomId("setup_reset").setLabel("🔴 Reset Setup").setStyle(ButtonStyle.Danger);

  return [
    ...commandMenus,
    new ActionRowBuilder().addComponents(channelsButton, prefixesButton, autoPingButton, logButton),
    new ActionRowBuilder().addComponents(appealButton, finishButton, resetButton)
  ];
}

function logSetupPanel(guildId) {
  const settings = getSettings(guildId);
  const enabled = getEnabledLogEvents(settings);
  const channel = settings.log_channel_id ? channelMention(settings.log_channel_id) : "Not set";
  const eventNames = LOG_EVENT_OPTIONS.filter(option => enabled.includes(option.value)).map(option => option.label);
  const embed = publicEmbed("📜 Log Setup", `Log destination: ${channel}\nEnabled events: ${eventNames.length ? eventNames.join(", ") : "None"}`, 0x5865F2);
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId("setup_log_channel_select")
    .setPlaceholder("Choose where logs are posted")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const eventSelect = new StringSelectMenuBuilder()
    .setCustomId("setup_log_events_select")
    .setPlaceholder("Choose which events to log")
    .setMinValues(1)
    .setMaxValues(LOG_EVENT_OPTIONS.length + 1)
    .addOptions([
      ...LOG_EVENT_OPTIONS.map(option => ({ ...option, default: enabled.includes(option.value) })),
      { label: "Disable all event logs", value: "none", description: "Stop sending event logs", default: enabled.length === 0 }
    ]);

  return {
    embed,
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(eventSelect),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("setup_log_done").setLabel("✅ Done").setStyle(ButtonStyle.Success))
    ]
  };
}

function blacklistAppealModal() {
  const input = new TextInputBuilder()
    .setCustomId("setup_appeal_link_input")
    .setLabel("Appeal invite link or server ID")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("https://discord.gg/abcd1234 or 123456789012345678")
    .setRequired(false)
    .setMaxLength(300);

  return new ModalBuilder()
    .setCustomId("setup_appeal_modal")
    .setTitle("Blacklist Appeal Link")
    .addComponents(new ActionRowBuilder().addComponents(input));
}


function channelSelects() {
  const blacklist = new ChannelSelectMenuBuilder().setCustomId("setup_blacklist_channel").setPlaceholder("📢 Choose Blacklist Log Channel").addChannelTypes(ChannelType.GuildText);
  const unblacklist = new ChannelSelectMenuBuilder().setCustomId("setup_unblacklist_channel").setPlaceholder("📢 Choose Unblacklist Log Channel").addChannelTypes(ChannelType.GuildText);
  const autoPing = new ChannelSelectMenuBuilder().setCustomId("setup_auto_ping_channel").setPlaceholder("📣 Choose Join Ping Channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const done = new ButtonBuilder().setCustomId("setup_channels_done").setLabel("✅ Done").setStyle(ButtonStyle.Success);

  return [
    new ActionRowBuilder().addComponents(blacklist),
    new ActionRowBuilder().addComponents(unblacklist),
    new ActionRowBuilder().addComponents(autoPing),
    new ActionRowBuilder().addComponents(done)
  ];
}

function prefixSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup_prefix_select")
      .setPlaceholder("🔤 Select your prefixes")
      .setMinValues(1)
      .setMaxValues(PREFIX_OPTIONS.length)
      .addOptions(PREFIX_OPTIONS.map(prefix => ({ label: prefix, value: prefix })))
  );
}

function roleSelectFor(command) {
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`setup_role_select:${command}`)
      .setPlaceholder(`Select roles for /${command}`)
      .setMinValues(1)
      .setMaxValues(25)
  );
}

function resetConfirmRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_reset_yes").setLabel("Yes, Reset Setup").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("setup_reset_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show bot commands and help information"),
    new SlashCommandBuilder().setName("serverinfo").setDescription("Show information about this server"),
    new SlashCommandBuilder().setName("serverlogs").setDescription("Configure server audit logs for moderation and server changes").addChannelOption(option => option.setName("channel").setDescription("Channel for audit log entries").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)).addBooleanOption(option => option.setName("enabled").setDescription("Enable or disable audit logging").setRequired(false)),
    new SlashCommandBuilder().setName("userinfo").setDescription("Show information about a server member").addUserOption(option => option.setName("user").setDescription("Member to inspect; defaults to you").setRequired(false)),
    new SlashCommandBuilder().setName("autoping").setDescription("Enable or disable auto-pinging new members in a channel").addChannelOption(option => option.setName("channel").setDescription("Channel to ghost ping when a member joins").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)).addBooleanOption(option => option.setName("enabled").setDescription("Turn the join ping on or off").setRequired(false)),
    new SlashCommandBuilder().setName("setup").setDescription("Configure the bot"),
    new SlashCommandBuilder().setName("warn").setDescription("Warn a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(true)),
    new SlashCommandBuilder().setName("warns").setDescription("Check a user's warnings").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("strike").setDescription("Manage staff strikes")
      .addSubcommand(subcommand => subcommand.setName("add").setDescription("Give a staff member a strike")
        .addUserOption(option => option.setName("user").setDescription("Staff member to strike").setRequired(true))
        .addStringOption(option => option.setName("reason").setDescription("Reason for the strike").setMaxLength(500).setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName("delete").setDescription("Delete one selected strike from a staff member")
        .addUserOption(option => option.setName("user").setDescription("Staff member whose strike to delete").setRequired(true))),
    new SlashCommandBuilder().setName("strikecheck").setDescription("Check a staff member's strike history").addUserOption(option => option.setName("user").setDescription("Staff member whose strikes to check").setRequired(true)),
    new SlashCommandBuilder().setName("strikelist").setDescription("List staff with strikes and their count out of 3"),
    new SlashCommandBuilder().setName("deletewarns").setDescription("Delete a warning").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("kick").setDescription("Kick a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(true)),
    new SlashCommandBuilder().setName("case").setDescription("View a blacklist case by its sequential number").addIntegerOption(option => option.setName("case").setDescription("Blacklist case number").setMinValue(1).setRequired(true)),
    new SlashCommandBuilder().setName("editcase").setDescription("Edit the reason on a blacklist case").addIntegerOption(option => option.setName("case").setDescription("Blacklist case number").setMinValue(1).setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Updated reason").setMaxLength(1000).setRequired(true)),
    new SlashCommandBuilder().setName("raid").setDescription("Toggle raid protection").addBooleanOption(option => option.setName("enabled").setDescription("Turn raid protection on or off").setRequired(true)),
    new SlashCommandBuilder().setName("logs").setDescription("Show recent moderation and security events"),
    new SlashCommandBuilder().setName("blacklist").setDescription("Blacklist a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("category").setDescription("Blacklist category").setRequired(true).addChoices(...CATEGORY_CHOICES)).addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(true)),
    new SlashCommandBuilder().setName("blacklistlist").setDescription("List currently blacklisted members"),
    new SlashCommandBuilder().setName("blacklistcheck").setDescription("Check blacklist status").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("unblacklist").setDescription("Unblacklist a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for removing the blacklist").setRequired(true)),
    new SlashCommandBuilder().setName("mute").setDescription("Timeout a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("duration").setDescription("Example: 10m, 1h, 1d").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(false)),
    new SlashCommandBuilder().setName("unmute").setDescription("Remove a timeout from a user").addUserOption(option => option.setName("user").setDescription("User").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for removing the timeout").setRequired(true)),
    new SlashCommandBuilder().setName("modlogs").setDescription("View moderator logs").addUserOption(option => option.setName("moderator").setDescription("Moderator").setRequired(true)),
    new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages from this channel").addIntegerOption(option => option.setName("amount").setDescription("Number of messages to delete (1-100)").setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName("slowmode").setDescription("Set or clear this channel's slowmode delay").addIntegerOption(option => option.setName("seconds").setDescription("Delay between messages (0 to disable, max 21600)").setMinValue(0).setMaxValue(21600).setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for changing slowmode").setRequired(false)),
    new SlashCommandBuilder().setName("lock").setDescription("Lock this channel for @everyone"),
    new SlashCommandBuilder().setName("unlock").setDescription("Unlock this channel for @everyone"),
    new SlashCommandBuilder().setName("addrole").setDescription("Add a role to a user").addUserOption(option => option.setName("user").setDescription("User to receive the role").setRequired(true)).addRoleOption(option => option.setName("role").setDescription("Role to add").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for adding the role").setRequired(false)),
    new SlashCommandBuilder().setName("removerole").setDescription("Remove a role from a user").addUserOption(option => option.setName("user").setDescription("User to remove the role from").setRequired(true)).addRoleOption(option => option.setName("role").setDescription("Role to remove").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for removing the role").setRequired(false)),
    new SlashCommandBuilder().setName("temprole").setDescription("Give a user a temporary role").addUserOption(option => option.setName("user").setDescription("User to receive the temporary role").setRequired(true)).addRoleOption(option => option.setName("role").setDescription("Temporary role to give").setRequired(true)).addStringOption(option => option.setName("duration").setDescription("Example: 10m, 1h, 1d").setRequired(true)).addStringOption(option => option.setName("reason").setDescription("Reason for the temporary role").setRequired(false)),
    new SlashCommandBuilder().setName("whitelist").setDescription("Manage anti-nuke exemptions")
      .addSubcommand(subcommand => subcommand.setName("add").setDescription("Exempt a member from automatic anti-nuke blacklisting").addUserOption(option => option.setName("user").setDescription("Member to exempt").setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName("remove").setDescription("Remove a member's anti-nuke exemption").addUserOption(option => option.setName("user").setDescription("Member to remove").setRequired(true))),
    new SlashCommandBuilder().setName("honeypot").setDescription("Configure a monitored honeypot channel")
      .addSubcommand(subcommand => subcommand.setName("setup").setDescription("Set the channel to monitor").addChannelOption(option => option.setName("channel").setDescription("Channel to monitor").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName("status").setDescription("Show the current honeypot channel"))
      .addSubcommand(subcommand => subcommand.setName("disable").setDescription("Disable honeypot monitoring")),
    new SlashCommandBuilder().setName("testsecuritydm").setDescription("Send server administrators a QIRA anti-nuke test DM")
  ];

  const { REST } = require("@discordjs/rest");
  const { Routes } = require("discord-api-types/v10");

  const api = new REST({ version: "10" }).setToken(TOKEN);

  const commandNames = commands.map(command => command.name);
  if (new Set(commandNames).size !== commandNames.length) {
    const duplicates = commandNames.filter((name, index) => commandNames.indexOf(name) !== index);
    throw new Error(`Duplicate slash command names: ${[...new Set(duplicates)].join(", ")}`);
  }
  await api.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  await api.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands.map(command => command.toJSON())
  });

  console.log("✅ Slash commands registered without stale duplicates!");
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = interaction.commandName;
      const guild = interaction.guild;

      if (!guild) return;

      if (command === "help") {
        return interaction.reply({ embeds: [helpEmbed()] });
      }

      if (command === "serverinfo") {
        return interaction.reply({ embeds: [serverInfoEmbed(guild)] });
      }

      if (command === "serverlogs") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ embeds: [errorEmbed("You need Manage Server permission to configure `/serverlogs`.")], ephemeral: true });
        }

        const channel = interaction.options.getChannel("channel");
        const enabled = interaction.options.getBoolean("enabled");
        const settings = getSettings(guild.id);
        const willEnable = channel ? enabled !== false : enabled === true;

        if (willEnable && !guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
          return interaction.reply({ embeds: [errorEmbed("I need View Audit Log permission to identify who made each change.")], ephemeral: true });
        }

        if (channel) {
          const botPermissions = channel.permissionsFor(guild.members.me);
          if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
              !botPermissions.has(PermissionFlagsBits.SendMessages) ||
              !botPermissions.has(PermissionFlagsBits.EmbedLinks)) {
            return interaction.reply({ embeds: [errorEmbed("I need View Channel, Send Messages, and Embed Links permissions in that channel.")], ephemeral: true });
          }
        }

        if (channel || enabled !== null) {
          if (channel) {
            db.prepare(`
              UPDATE settings
              SET server_log_channel_id = ?, server_logs_enabled = ?
              WHERE guild_id = ?
            `).run(channel.id, enabled === false ? 0 : 1, guild.id);
          } else if (enabled === false) {
            db.prepare(`UPDATE settings SET server_logs_enabled = 0 WHERE guild_id = ?`).run(guild.id);
          } else if (enabled === true && !settings.server_log_channel_id) {
            return interaction.reply({ embeds: [errorEmbed("Choose a channel first with `/serverlogs channel:#channel`.")], ephemeral: true });
          } else {
            db.prepare(`UPDATE settings SET server_logs_enabled = 1 WHERE guild_id = ?`).run(guild.id);
          }

          const updated = getSettings(guild.id);
          return interaction.reply({
            embeds: [publicEmbed(
              "🧾 Server Audit Logs",
              `${updated.server_logs_enabled ? "Enabled" : "Disabled"}\nChannel: ${channelMention(updated.server_log_channel_id)}\nTracked events: message deletes, moderation, member, role, channel, and server changes.`,
              updated.server_logs_enabled ? 0x57F287 : 0x5865F2
            )],
            ephemeral: true
          });
        }

        return interaction.reply({
          embeds: [publicEmbed(
            "🧾 Server Audit Logs",
            `${settings.server_logs_enabled ? "Enabled" : "Disabled"}\nChannel: ${channelMention(settings.server_log_channel_id)}\nTracked events: message deletes, moderation, member, role, channel, and server changes.`,
            0x5865F2
          )],
          ephemeral: true
        });
      }

      if (command === "userinfo") {
        await interaction.deferReply();
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) {
          return interaction.editReply({ embeds: [errorEmbed("That user is not a member of this server.")] });
        }

        return interaction.editReply({ embeds: [userInfoEmbed(member)] });
      }

      if (command === "autoping") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ embeds: [errorEmbed("Only administrators can configure auto join pinging." )], ephemeral: true });
        }

        const channel = interaction.options.getChannel("channel");
        const enabledValue = interaction.options.getBoolean("enabled");
        const settings = getSettings(guild.id);

        if (channel) {
          setAutoPingChannel(guild.id, channel.id, true);
          return interaction.reply({ embeds: [publicEmbed("📣 Auto Ping Enabled", `Ghost-pings will be sent in ${channel} whenever a member joins.`, 0x57F287)], ephemeral: true });
        }

        if (enabledValue !== null) {
          if (enabledValue) {
            const existing = settings.auto_ping_channel_id;
            if (!existing) {
              return interaction.reply({ embeds: [errorEmbed("Choose a channel first, then enable auto pinging." )], ephemeral: true });
            }
            db.prepare(`UPDATE settings SET auto_ping_enabled = 1 WHERE guild_id = ?`).run(guild.id);
            return interaction.reply({ embeds: [publicEmbed("📣 Auto Ping Enabled", `Join ghost-pinging is enabled in ${channelMention(existing)}.`, 0x57F287)], ephemeral: true });
          }

          db.prepare(`UPDATE settings SET auto_ping_enabled = 0 WHERE guild_id = ?`).run(guild.id);
          return interaction.reply({ embeds: [publicEmbed("📣 Auto Ping Disabled", "Join ghost-pinging is now disabled for this server.", 0x5865F2)], ephemeral: true });
        }

        const currentChannel = settings.auto_ping_channel_id ? channelMention(settings.auto_ping_channel_id) : "Not set";
        const status = settings.auto_ping_enabled ? "Enabled" : "Disabled";
        return interaction.reply({ embeds: [publicEmbed("📣 Auto Ping Status", `Status: ${status}\nChannel: ${currentChannel}`, 0x5865F2)], ephemeral: true });
      }

      if (command === "testsecuritydm") {
        const botMember = guild.members.me;
        if (!botMember || interaction.member.roles.highest.comparePositionTo(botMember.roles.highest) <= 0) {
          return interaction.reply({ embeds: [errorEmbed("Only members with a role higher than the bot can send administrator test DMs.")], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const displayName = interaction.member.displayName || interaction.user.globalName || interaction.user.username;
        const delivery = await notifyGuildAdministrators(guild, `this is a nuke msg test from ${displayName}`);
        return interaction.editReply({ embeds: [publicEmbed("📨 Security DM Test", `Sent to ${delivery.dmCount} of ${delivery.adminCount} administrator(s). Some admins may have DMs disabled.`, 0x57F287)] });
      }

      if (command === "honeypot") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ embeds: [errorEmbed("You need the Manage Server permission to configure the honeypot.")], ephemeral: true });
        }

        const action = interaction.options.getSubcommand();
        if (action === "setup") {
          const channel = interaction.options.getChannel("channel", true);
          if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            return interaction.reply({ embeds: [errorEmbed("Choose a text or announcement channel.")], ephemeral: true });
          }

          const botMember = guild.members.me;
          if (!botMember) {
            return interaction.reply({ embeds: [errorEmbed("I couldn't verify my server permissions. Please try again in a moment.")], ephemeral: true });
          }

          const botPermissions = channel.permissionsFor(botMember);
          if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({ embeds: [errorEmbed("I need View Channel and Manage Messages permissions in the honeypot channel.")], ephemeral: true });
          }
          if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
            return interaction.reply({ embeds: [errorEmbed("I need the Kick Members server permission to enable the honeypot.")], ephemeral: true });
          }

          db.prepare(`
            INSERT INTO honeypot_settings (guild_id, channel_id)
            VALUES (?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
          `).run(guild.id, channel.id);
          return interaction.reply({ embeds: [publicEmbed("🍯 Honeypot Configured", `${channel} is now monitored. Non-admin members who speak here will have their message deleted and be kicked automatically.`, 0x57F287)], ephemeral: true });
        }

        if (action === "disable") {
          const result = db.prepare("DELETE FROM honeypot_settings WHERE guild_id = ?").run(guild.id);
          const description = result.changes ? "Honeypot monitoring has been disabled." : "Honeypot monitoring was not configured.";
          return interaction.reply({ embeds: [publicEmbed("🍯 Honeypot", description, 0x5865F2)], ephemeral: true });
        }

        const config = db.prepare("SELECT channel_id FROM honeypot_settings WHERE guild_id = ?").get(guild.id);
        return interaction.reply({ embeds: [publicEmbed("🍯 Honeypot Status", config ? `Monitoring ${channelMention(config.channel_id)}.` : "Honeypot monitoring is not configured.", 0x5865F2)], ephemeral: true });
      }

      if (command === "whitelist") {
        const botMember = guild.members.me;
        if (!botMember || interaction.member.roles.highest.comparePositionTo(botMember.roles.highest) <= 0) {
          return interaction.reply({ embeds: [errorEmbed("Only members with a role higher than the bot can manage the anti-nuke whitelist.")], ephemeral: true });
        }

        const action = interaction.options.getSubcommand();
        const target = interaction.options.getUser("user");
        if (action === "add") {
          const result = db.prepare(`
            INSERT OR IGNORE INTO anti_nuke_whitelist (guild_id, user_id)
            VALUES (?, ?)
          `).run(guild.id, target.id);
          const description = result.changes ? `${userMention(target.id)} is now exempt from automatic anti-nuke blacklisting.` : `${userMention(target.id)} is already on the anti-nuke whitelist.`;
          return interaction.reply({ embeds: [publicEmbed("🛡️ Anti-Nuke Whitelist", description, 0x57F287)], ephemeral: true });
        }

        const result = db.prepare(`
          DELETE FROM anti_nuke_whitelist
          WHERE guild_id = ? AND user_id = ?
        `).run(guild.id, target.id);
        const description = result.changes ? `${userMention(target.id)} was removed from the anti-nuke whitelist.` : `${userMention(target.id)} was not on the anti-nuke whitelist.`;
        return interaction.reply({ embeds: [publicEmbed("🛡️ Anti-Nuke Whitelist", description, 0x5865F2)], ephemeral: true });
      }

      if (command === "purge") {
        if (!hasCommandAccess(interaction, "purge")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/purge`.")], ephemeral: true });
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ embeds: [errorEmbed("You need the Manage Messages permission to use `/purge`.")], ephemeral: true });
        }

        const channel = interaction.channel;
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
          return interaction.reply({ embeds: [errorEmbed("`/purge` can only be used in a text or announcement channel.")], ephemeral: true });
        }

        const botPermissions = channel.permissionsFor(guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.ManageMessages) || !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)) {
          return interaction.reply({ embeds: [errorEmbed("I need Manage Messages and Read Message History permissions to purge messages.")], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        try {
          const deleted = await channel.bulkDelete(interaction.options.getInteger("amount"), true);
          return interaction.editReply({ embeds: [publicEmbed("🧹 Messages Purged", `Deleted ${deleted.size} message(s). Messages older than 14 days cannot be bulk deleted.`, 0x57F287)] });
        } catch (error) {
          console.error("Purge failed:", error);
          return interaction.editReply({ embeds: [errorEmbed("I couldn't delete those messages. Check my channel permissions and try again.")] });
        }
      }

      if (command === "slowmode") {
        if (!hasCommandAccess(interaction, "slowmode")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/slowmode`.")], ephemeral: true });
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({ embeds: [errorEmbed("You need the Manage Channels permission to use `/slowmode`.")], ephemeral: true });
        }

        const channel = interaction.channel;
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
          return interaction.reply({ embeds: [errorEmbed("`/slowmode` can only be used in a text or announcement channel.")], ephemeral: true });
        }

        const botPermissions = channel.permissionsFor(guild.members.me);
        if (!botPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({ embeds: [errorEmbed("I need the Manage Channels permission in this channel to change its slowmode.")], ephemeral: true });
        }

        const seconds = interaction.options.getInteger("seconds");
        const reason = interaction.options.getString("reason") || `Changed by ${interaction.user.tag}`;
        await interaction.deferReply({ ephemeral: true });
        try {
          await channel.setRateLimitPerUser(seconds, reason);
          addModLog(guild.id, "slowmode", interaction.user.id, interaction.user.id, reason);
          const result = seconds === 0 ? "disabled" : `set to ${seconds} second(s)`;
          return interaction.editReply({ embeds: [publicEmbed("🐢 Slowmode Updated", `Slowmode in ${channel} was ${result}.`, 0x57F287)] });
        } catch (error) {
          console.error("Slowmode update failed:", error);
          return interaction.editReply({ embeds: [errorEmbed("I couldn't update slowmode. Check my channel permissions and try again.")] });
        }
      }

      if (command === "lock" || command === "unlock") {
        if (!hasCommandAccess(interaction, command)) {
          return interaction.reply({ embeds: [errorEmbed(`You don't have permission to use \`/${command}\`.`)], ephemeral: true });
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({ embeds: [errorEmbed(`You need the Manage Channels permission to use \`/${command}\`.`)], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const result = await setChannelLock(guild, interaction.channel, command === "lock");
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

        const action = result.locked ? "locked" : "unlocked";
        return interaction.editReply({ embeds: [publicEmbed(`🔒 Channel ${action}`, `${result.channel} has been ${action} for @everyone.`, result.locked ? 0xED4245 : 0x57F287)] });
      }

      if (command === "setup") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ embeds: [errorEmbed("Only server administrators can use `/setup`.")], ephemeral: true });
        }

        ensureSettings(guild.id);
        return interaction.reply({ embeds: [setupSummary(guild.id)], components: setupControls(), ephemeral: true });
      }

      if (command === "warn") {
        if (!hasCommandAccess(interaction, "warn")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/warn`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const reason = interaction.options.getString("reason");

        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });

        const result = db.prepare(`
          INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(guild.id, target.id, interaction.user.id, reason, now());

        addModLog(guild.id, "warn", target.id, interaction.user.id, reason);

        let dmStatus = "❌ Failed";
        try {
          await target.send({
            embeds: [publicEmbed("⚠️ You Have Been Warned", `You were warned in **${guild.name}** by ${userMention(interaction.user.id)}.`, 0xFEE75C).addFields(
              { name: "📝 Reason", value: safeText(reason) },
              { name: "🏠 Server", value: guild.name, inline: true },
              { name: "👮 Moderator", value: userMention(interaction.user.id), inline: true }
            )]
          });
          dmStatus = "✅ Sent";
        } catch {
          dmStatus = "❌ Failed (DMs may be disabled)";
        }

        return interaction.editReply({
          embeds: [publicEmbed("⚠️ User Warned", `${userMention(target.id)} has received a warning.`, 0xFEE75C).addFields(
            { name: "👤 User", value: userMention(target.id), inline: true },
            { name: "👮 Moderator", value: userMention(interaction.user.id), inline: true },
            { name: "⚠️ Warning ID", value: `#${result.lastInsertRowid}`, inline: true },
            { name: "📝 Reason", value: safeText(reason) },
            { name: "📩 DM Status", value: dmStatus, inline: true }
          )]
        });
      }

      if (command === "warns") {
        if (!hasCommandAccess(interaction, "warns")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/warns`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });

        const warnings = db.prepare(`
          SELECT *
          FROM warnings
          WHERE guild_id = ?
          AND user_id = ?
          ORDER BY id DESC
        `).all(guild.id, target.id);

        if (!warnings.length) {
          return interaction.editReply({ embeds: [publicEmbed("⚠️ Warnings", `${userMention(target.id)} has no warnings.`, 0x57F287)] });
        }

        const embed = publicEmbed("⚠️ User Warnings", `${userMention(target.id)} has **${warnings.length}** warning(s).`, 0xFEE75C);
        for (const warning of warnings.slice(0, 25)) {
          embed.addFields({ name: `Warning #${warning.id}`, value: `**Reason:** ${safeText(warning.reason)}\n**Moderator:** ${userMention(warning.moderator_id)}\n**Date:** ${timestamp(warning.created_at)}` });
        }

        return interaction.editReply({ embeds: [embed] });
      }

      if (command === "kick") {
        if (!hasCommandAccess(interaction, "kick")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/kick`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const reason = interaction.options.getString("reason");
        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });
        if (!canModerateMember(guild, interaction.member, target)) return interaction.editReply({ embeds: [errorEmbed("That user is higher than you in the hierarchy.")] });
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.editReply({ embeds: [errorEmbed("I need the Kick Members permission.")] });

        try {
          await target.kick(reason || "No reason provided");
        } catch (error) {
          console.error("Kick failed:", error);
          return interaction.editReply({ embeds: [errorEmbed("I couldn't kick that user.")] });
        }

        addModLog(guild.id, "kick", target.id, interaction.user.id, reason || "No reason provided");
        return interaction.editReply({ embeds: [publicEmbed("👢 User Kicked", `${userMention(target.id)} was kicked.`, 0xED4245).addFields(
          { name: "👤 User", value: userMention(target.id), inline: true },
          { name: "👮 Moderator", value: userMention(interaction.user.id), inline: true },
          { name: "📝 Reason", value: safeText(reason || "No reason provided") }
        )] });
      }

      if (command === "case") {
        if (!hasCommandAccess(interaction, "case")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/case`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const caseId = interaction.options.getInteger("case");
        const record = db.prepare(`
          SELECT *
          FROM blacklist_records
          WHERE guild_id = ?
          AND case_number = ?
        `).get(guild.id, caseId);

        if (!record) {
          return interaction.editReply({ embeds: [errorEmbed(`I couldn't find blacklist case #${caseId}.`)] });
        }

        return interaction.editReply({ embeds: [blacklistCaseEmbed(record)] });
      }

      if (command === "editcase") {
        if (!hasCommandAccess(interaction, "editcase")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/editcase`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const caseId = interaction.options.getInteger("case");
        const newReason = interaction.options.getString("reason");
        const existing = db.prepare(`
          SELECT *
          FROM blacklist_records
          WHERE guild_id = ?
          AND case_number = ?
        `).get(guild.id, caseId);

        if (!existing) {
          return interaction.editReply({ embeds: [errorEmbed(`I couldn't find blacklist case #${caseId}.`)] });
        }

        db.prepare(`
          UPDATE blacklist_records
          SET reason = ?
          WHERE guild_id = ?
          AND case_number = ?
        `).run(newReason, guild.id, caseId);

        const updated = db.prepare(`
          SELECT *
          FROM blacklist_records
          WHERE guild_id = ?
          AND case_number = ?
        `).get(guild.id, caseId);

        return interaction.editReply({ embeds: [blacklistCaseEmbed(updated, "✏️ Blacklist Case Updated", `Updated blacklist case #${updated.case_number}.`)] });
      }

      if (command === "raid") {
        if (!hasCommandAccess(interaction, "raid")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/raid`.")], ephemeral: true });
        }

        const enabled = interaction.options.getBoolean("enabled");
        if (!canActivateSecurityCommand(guild, interaction.member)) {
          return interaction.reply({ embeds: [errorEmbed("Only a member above the bot can activate raid protection.")], ephemeral: true });
        }

        if (enabled) {
          raidProtectionUntil.set(guild.id, Date.now() + (24 * 60 * 60 * 1000));
          return interaction.reply({ embeds: [publicEmbed("🛡️ Raid Protection Enabled", "Raid protection has been activated for this server. A member above the bot can disable it later.", 0xED4245)] });
        }

        raidProtectionUntil.delete(guild.id);
        return interaction.reply({ embeds: [publicEmbed("🛡️ Raid Protection Disabled", "Raid protection has been disabled for this server.", 0x57F287)] });
      }

      if (command === "deletewarns") {
        if (!hasCommandAccess(interaction, "deletewarns")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/deletewarns`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });

        const warnings = db.prepare(`
          SELECT *
          FROM warnings
          WHERE guild_id = ?
          AND user_id = ?
          ORDER BY id DESC
        `).all(guild.id, target.id);

        if (!warnings.length) {
          return interaction.editReply({ embeds: [publicEmbed("🗑️ Delete Warnings", `${userMention(target.id)} has no warnings.`, 0x57F287)] });
        }

        const rows = [];
        for (let i = 0; i < warnings.length && rows.length < 5; i += 5) {
          const row = new ActionRowBuilder();
          for (const warning of warnings.slice(i, i + 5)) {
            row.addComponents(new ButtonBuilder().setCustomId(`delete_warning:${warning.id}`).setLabel(`Delete #${warning.id}`).setStyle(ButtonStyle.Danger));
          }
          rows.push(row);
        }

        return interaction.editReply({ embeds: [publicEmbed("🗑️ Delete Warnings", `Choose a warning to delete for ${userMention(target.id)}.`, 0xED4245).addFields({ name: "⚠️ Warning Count", value: String(warnings.length), inline: true })], components: rows });
      }

      if (command === "blacklist") {
        if (!hasCommandAccess(interaction, "blacklist")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/blacklist`.")], ephemeral: true });
        }

        await interaction.deferReply();

        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const category = interaction.options.getString("category");
        const reason = interaction.options.getString("reason");

        const result = await doBlacklist(guild, interaction.member, target, category, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

        await interaction.editReply({ embeds: [result.embed] });

        const settings = getSettings(guild.id);
        if (settings.blacklist_channel_id) {
          const channel = guild.channels.cache.get(settings.blacklist_channel_id);
          if (channel && channel.isTextBased()) await channel.send({ embeds: [result.embed] }).catch(() => {});
        }

        return;
      }

      if (command === "blacklistcheck") {
        if (!hasCommandAccess(interaction, "blacklistcheck")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/blacklistcheck`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });

        const record = db.prepare(`
          SELECT *
          FROM blacklist_records
          WHERE guild_id = ?
          AND user_id = ?
          ORDER BY id DESC
          LIMIT 1
        `).get(guild.id, target.id);

        if (!record) {
          return interaction.editReply({ embeds: [publicEmbed("🔎 Blacklist Check", `${userMention(target.id)} has no blacklist record.`, 0x57F287)] });
        }

        return interaction.editReply({
          embeds: [publicEmbed("🔎 Blacklist Check", `${userMention(target.id)} blacklist record.`, record.active ? 0xED4245 : 0x57F287).addFields(
            { name: "Status", value: record.active ? "⛔ Active" : "✅ Inactive", inline: true },
            { name: "Category", value: record.category, inline: true },
            { name: "Roles Stored", value: String(record.roles_count), inline: true },
            { name: "Reason", value: safeText(record.reason) },
            { name: "Moderator", value: userMention(record.moderator_id), inline: true },
            { name: "Date", value: timestamp(record.created_at), inline: true }
          )]
        });
      }

      if (command === "blacklistlist") {
        if (!hasCommandAccess(interaction, "blacklistlist")) {
          return interaction.reply({ embeds: [errorEmbed("You need Administrator, Moderate Members, or a role assigned to `/blacklistlist` in `/setup`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const result = blacklistListEmbed(guild.id, 1);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({
          content: result.mentionContent,
          embeds: [result.embed],
          components: result.components,
          allowedMentions: { users: result.moderatorIds }
        });
      }

      if (command === "unblacklist") {
        if (!hasCommandAccess(interaction, "unblacklist")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/unblacklist`.")], ephemeral: true });
        }

        await interaction.deferReply();

        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const reason = interaction.options.getString("reason");
        if (!target) return interaction.editReply({ embeds: [errorEmbed("User not found.")] });

        const result = await doUnblacklist(guild, interaction.member, target, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

        await interaction.editReply({ embeds: [result.embed] });

        const settings = getSettings(guild.id);
        if (settings.unblacklist_channel_id) {
          const channel = guild.channels.cache.get(settings.unblacklist_channel_id);
          if (channel && channel.isTextBased()) await channel.send({ embeds: [result.embed] }).catch(() => {});
        }

        return;
      }

      if (command === "mute") {
        if (!hasCommandAccess(interaction, "mute")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/mute`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const duration = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || "No reason provided";

        const result = await doMute(guild, interaction.member, target, duration, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

        return interaction.editReply({ embeds: [result.embed] });
      }

      if (command === "unmute") {
        if (!hasCommandAccess(interaction, "unmute")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/unmute`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const reason = interaction.options.getString("reason");
        const result = await doUnmute(guild, interaction.member, target, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({ embeds: [result.embed] });
      }

      if (command === "addrole") {
        if (!hasCommandAccess(interaction, "addrole")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/addrole`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const role = interaction.options.getRole("role");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const result = await doAddRole(guild, interaction.member, target, role, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({ embeds: [result.embed] });
      }

      if (command === "removerole") {
        if (!hasCommandAccess(interaction, "removerole")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/removerole`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const role = interaction.options.getRole("role");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const result = await doRemoveRole(guild, interaction.member, target, role, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({ embeds: [result.embed] });
      }

      if (command === "temprole") {
        if (!hasCommandAccess(interaction, "temprole")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/temprole`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const target = await guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
        const role = interaction.options.getRole("role");
        const duration = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const result = await doTempRole(guild, interaction.member, target, role, duration, reason);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({ embeds: [result.embed] });
      }

      if (command === "modlogs") {
        if (!hasCommandAccess(interaction, "modlogs")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/modlogs`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const moderator = interaction.options.getUser("moderator");
        if (!moderator) {
          return interaction.editReply({ embeds: [errorEmbed("Select a moderator to view their logs.")] });
        }

        return interaction.editReply({ embeds: [modlogsEmbed(guild.id, moderator.id)] });
      }

      if (command === "logs") {
        if (!hasCommandAccess(interaction, "logs")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/logs`.")], ephemeral: true });
        }

        await interaction.deferReply();
        const rows = db.prepare(`
          SELECT *
          FROM moderation
          WHERE guild_id = ?
          ORDER BY id DESC
          LIMIT 10
        `).all(guild.id);

        if (!rows.length) {
          return interaction.editReply({ embeds: [publicEmbed("📜 Recent Logs", "No moderation or security events have been recorded yet.", 0x5865F2)] });
        }

        const embed = publicEmbed("📜 Recent Server Logs", "Latest moderation and security events.", 0x5865F2);
        for (const row of rows) {
          embed.addFields({
            name: `#${row.id} • ${String(row.action || "event").toUpperCase()}`,
            value: `User: ${userMention(row.user_id)}\nModerator: ${userMention(row.moderator_id)}\nReason: ${safeText(row.reason || "No reason provided")}\nDate: ${timestamp(row.created_at)}`
          });
        }

        return interaction.editReply({ embeds: [embed] });
      }

      if (command === "strike" || command === "strikecheck") {
        const checkingStrikes = command === "strikecheck";
        const strikeAction = checkingStrikes ? "check" : interaction.options.getSubcommand(false) || "add";
        const permissionCommand = checkingStrikes ? "strikecheck" : "strike";
        if (!hasCommandAccess(interaction, permissionCommand)) {
          return interaction.reply({ embeds: [errorEmbed(`You don't have permission to use \`/${command}\`.`)] });
        }
        if (!canActivateSecurityCommand(guild, interaction.member)) {
          return interaction.reply({ embeds: [errorEmbed(`You must have a role above the bot to use \`/${command}\`.`)] });
        }

        const targetUser = interaction.options.getUser("user", true);

        await interaction.deferReply();
        const target = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!target) return interaction.editReply({ embeds: [errorEmbed("That user is not a member of this server.")] });

        if (strikeAction === "delete") {
          const result = strikeDeleteSelection(guild.id, target.id);
          return interaction.editReply({ embeds: [result.embed], components: result.components });
        }

        if (strikeAction === "add") {
          if (target.user.bot) return interaction.editReply({ embeds: [errorEmbed("Staff strikes can only be given to people, not bots.")] });
          if (!canModerateMember(guild, interaction.member, target)) {
            return interaction.editReply({ embeds: [errorEmbed("You can only give a strike to a member below you in the role hierarchy.")] });
          }

          const reason = interaction.options.getString("reason", true).trim();
          const result = db.transaction(() => {
            const count = db.prepare(`
              SELECT COUNT(*) AS count
              FROM staff_strikes
              WHERE guild_id = ? AND user_id = ?
            `).get(guild.id, target.id).count;
            if (count >= 3) return { error: "That staff member already has the maximum of 3/3 strikes." };

            const createdAt = now();
            db.prepare(`
              INSERT INTO staff_strikes (guild_id, user_id, moderator_id, reason, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(guild.id, target.id, interaction.user.id, reason, createdAt);
            return { count: count + 1, createdAt };
          })();

          if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

          addModLog(guild.id, "staffstrike", target.id, interaction.user.id, reason);
          let dmStatus = "❌ Failed (DMs may be disabled)";
          try {
            await target.send({
              embeds: [publicEmbed(
                "⚠️ You Received a Staff Strike",
                `You received a staff strike in **${safeText(guild.name)}** from ${userMention(interaction.user.id)}.`,
                0xFEE75C
              ).addFields(
                { name: "Strike Count", value: `${result.count}/3`, inline: true },
                { name: "Reason", value: safeText(reason) }
              )]
            });
            dmStatus = "✅ Sent";
          } catch (error) {
            console.warn(`Could not DM ${target.user.tag} about staff strike:`, error.message);
          }

          return interaction.editReply({ embeds: [publicEmbed(
            "⚠️ Staff Strike Given",
            `${userMention(target.id)} now has **${result.count}/3** staff strikes.`,
            result.count >= 3 ? 0xED4245 : 0xFEE75C
          ).addFields(
            { name: "Reason", value: safeText(reason) },
            { name: "Given By", value: userMention(interaction.user.id), inline: true },
            { name: "Date", value: timestamp(result.createdAt), inline: true },
            { name: "DM Status", value: dmStatus, inline: true }
          )] });
        }

        const strikes = db.prepare(`
          SELECT id, moderator_id, reason, created_at,
            ROW_NUMBER() OVER (ORDER BY id ASC) AS strike_number
          FROM staff_strikes
          WHERE guild_id = ? AND user_id = ?
          ORDER BY id ASC
        `).all(guild.id, target.id);
        return interaction.editReply({ embeds: [staffStrikeEmbed(target, strikes)] });
      }

      if (command === "strikelist") {
        if (!hasCommandAccess(interaction, "strikelist") || !canActivateSecurityCommand(guild, interaction.member)) {
          return interaction.reply({ embeds: [errorEmbed("You must have a role above the bot to use `/strikelist`.")] });
        }

        await interaction.deferReply();
        const result = staffStrikeListEmbed(guild.id, 1);
        if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });
        return interaction.editReply({ embeds: [result.embed], components: result.components });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("strikelist_page:")) {
        if (!hasCommandAccess(interaction, "strikelist") || !canActivateSecurityCommand(interaction.guild, interaction.member)) {
          return interaction.reply({ embeds: [errorEmbed("You must have a role above the bot to use `/strikelist`.")] });
        }

        const page = Number.parseInt(interaction.customId.split(":").pop(), 10);
        const result = staffStrikeListEmbed(interaction.guild.id, page);
        if (result.error) return interaction.reply({ embeds: [errorEmbed(result.error)] });
        return interaction.update({ embeds: [result.embed], components: result.components });
      }

      if (interaction.customId.startsWith("blacklistlist_page:")) {
        if (!hasCommandAccess(interaction, "blacklistlist")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to use `/blacklistlist`.")], ephemeral: true });
        }

        const page = Number.parseInt(interaction.customId.split(":").pop(), 10);
        const result = blacklistListEmbed(interaction.guild.id, page);
        if (result.error) return interaction.reply({ embeds: [errorEmbed(result.error)], ephemeral: true });
        return interaction.update({
          content: result.mentionContent,
          embeds: [result.embed],
          components: result.components,
          allowedMentions: { users: result.moderatorIds }
        });
      }

      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed("Only administrators can change setup.")], ephemeral: true });
      }

      const id = interaction.customId;

      if (id === "setup_channels") {
        return interaction.update({ embeds: [publicEmbed("📢 Channel Setup", "Choose the blacklist, unblacklist, and join-ping channels below.\n\nThe blacklist logs go to the blacklist channel.\nThe unblacklist logs go to the unblacklist channel.\nThe auto-ping channel is used for ghost-ping on member join.", 0x5865F2)], components: channelSelects() });
      }

      if (id === "setup_log_channel") {
        const panel = logSetupPanel(interaction.guild.id);
        return interaction.update({ embeds: [panel.embed], components: panel.components });
      }

      if (id === "setup_log_done") {
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }

      if (id === "setup_auto_ping") {
        return interaction.update({ embeds: [publicEmbed("📣 Join Ping Setup", "Choose the channel that should receive a ghost ping whenever a member joins.", 0x5865F2)], components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId("setup_auto_ping_channel").setPlaceholder("📣 Pick a join ping channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setup_channels_done").setLabel("✅ Done").setStyle(ButtonStyle.Success)
          )
        ] });
      }

      if (id === "setup_appeal_link") {
        return interaction.showModal(blacklistAppealModal());
      }

      if (id === "setup_channels_done") {
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }

      if (id === "setup_prefixes") {
        return interaction.update({ embeds: [publicEmbed("🔤 Prefix Setup", "Select **as many prefixes as you want**.", 0x5865F2)], components: [prefixSelect()] });
      }

      if (id === "setup_finish") {
        db.prepare(`
          UPDATE settings
          SET setup_complete = 1
          WHERE guild_id = ?
        `).run(interaction.guild.id);

        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("setup_reset").setLabel("🔴 Reset Setup").setStyle(ButtonStyle.Danger))] });
      }

      if (id === "setup_reset") {
        return interaction.update({ embeds: [publicEmbed("⚠️ Reset Setup?", "Are you sure you want to reset the setup?\n\nThis will remove all command roles, prefixes and blacklist/unblacklist channels.", 0xED4245)], components: resetConfirmRows() });
      }

      if (id === "setup_reset_yes") {
        const guildId = interaction.guild.id;
        const transaction = db.transaction(() => {
          db.prepare(`DELETE FROM command_roles WHERE guild_id = ?`).run(guildId);
          db.prepare(`DELETE FROM prefixes WHERE guild_id = ?`).run(guildId);
          db.prepare(`UPDATE settings SET blacklist_channel_id = NULL, unblacklist_channel_id = NULL, log_channel_id = NULL, log_events_json = NULL, server_log_channel_id = NULL, server_logs_enabled = 0, appeal_link = NULL, setup_complete = 0 WHERE guild_id = ?`).run(guildId);
        });

        transaction();
        return interaction.update({ embeds: [publicEmbed("✅ Setup Reset", "The bot setup has been completely reset.", 0x57F287)], components: [] });
      }

      if (id === "setup_reset_no") {
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }

      if (id.startsWith("delete_warning:")) {
        if (!hasCommandAccess(interaction, "deletewarns")) {
          return interaction.reply({ embeds: [errorEmbed("You don't have permission to delete warnings.")], ephemeral: true });
        }

        const warningId = Number(id.split(":")[1]);
        const warning = db.prepare(`SELECT * FROM warnings WHERE guild_id = ? AND id = ?`).get(interaction.guild.id, warningId);

        if (!warning) {
          return interaction.reply({ embeds: [errorEmbed("That warning no longer exists.")], ephemeral: true });
        }

        db.prepare(`DELETE FROM warnings WHERE guild_id = ? AND id = ?`).run(interaction.guild.id, warningId);
        addModLog(interaction.guild.id, "deletewarn", warning.user_id, interaction.user.id, `Deleted warning #${warningId}`);

        return interaction.update({
          embeds: [publicEmbed("🗑️ Warning Deleted", `Warning **#${warningId}** belonging to ${userMention(warning.user_id)} has been deleted.`, 0x57F287).addFields(
            { name: "👮 Deleted By", value: userMention(interaction.user.id), inline: true },
            { name: "⚠️ Warning ID", value: `#${warningId}`, inline: true },
            { name: "📝 Original Reason", value: safeText(warning.reason) }
          )],
          components: []
        });
      }

      if (id.startsWith("delete_strike:")) {
        if (!canActivateSecurityCommand(interaction.guild, interaction.member)) {
          return interaction.reply({ embeds: [errorEmbed("Only a member above the bot can delete staff strikes.")] });
        }

        const strikeId = Number(id.split(":")[1]);
        const strike = db.prepare(`
          SELECT user_id, moderator_id, reason
          FROM staff_strikes
          WHERE guild_id = ? AND id = ?
        `).get(interaction.guild.id, strikeId);
        if (!strike) {
          return interaction.reply({ embeds: [errorEmbed("That staff strike no longer exists.")] });
        }

        const deletion = db.prepare(`
          DELETE FROM staff_strikes
          WHERE guild_id = ? AND id = ?
        `).run(interaction.guild.id, strikeId);
        if (!deletion.changes) {
          return interaction.reply({ embeds: [errorEmbed("That staff strike could not be deleted.")] });
        }

        const remainingCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM staff_strikes
          WHERE guild_id = ? AND user_id = ?
        `).get(interaction.guild.id, strike.user_id).count;
        addModLog(
          interaction.guild.id,
          "deletestrike",
          strike.user_id,
          interaction.user.id,
          `Deleted staff strike #${strikeId}: ${strike.reason}`
        );

        return interaction.update({
          embeds: [publicEmbed(
            "🗑️ Staff Strike Deleted",
            `Staff strike **#${strikeId}** for ${userMention(strike.user_id)} was deleted.`,
            0x57F287
          ).addFields(
            { name: "👮 Deleted By", value: userMention(interaction.user.id), inline: true },
            { name: "⚠️ Remaining Strikes", value: `${remainingCount}/3`, inline: true },
            { name: "📝 Original Reason", value: safeText(strike.reason) }
          )],
          components: []
        });
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "setup_appeal_modal") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ embeds: [errorEmbed("Only administrators can change setup.")], ephemeral: true });
        }

        const value = interaction.fields.getTextInputValue("setup_appeal_link_input").trim();
        db.prepare(`UPDATE settings SET appeal_link = ? WHERE guild_id = ?`).run(value || null, interaction.guild.id);

        return interaction.reply({ embeds: [publicEmbed("📎 Appeal Link Saved", value ? `Saved: ${value}` : "Cleared the appeal link.", 0x57F287)], ephemeral: true });
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed("Only administrators can change setup.")], ephemeral: true });
      }

      if (interaction.customId.startsWith("setup_command_select:")) {
        const command = interaction.values[0];
        return interaction.update({ embeds: [publicEmbed(`🎭 Roles for /${command}`, "Select the roles allowed to use this command.\n\nYou can select up to **25 roles at a time**. Open the menu again to replace/add another batch.", 0x5865F2)], components: [roleSelectFor(command)] });
      }

      if (interaction.customId === "setup_prefix_select") {
        savePrefixes(interaction.guild.id, interaction.values);
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }

      if (interaction.customId === "setup_log_events_select") {
        saveEnabledLogEvents(interaction.guild.id, interaction.values);
        const panel = logSetupPanel(interaction.guild.id);
        return interaction.update({ embeds: [panel.embed], components: panel.components });
      }
    }

    if (interaction.isRoleSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed("Only administrators can change setup.")], ephemeral: true });
      }

      if (interaction.customId.startsWith("setup_role_select:")) {
        const command = interaction.customId.split(":")[1];
        const existing = getCommandRoles(interaction.guild.id, command);
        const combined = [...new Set([...existing, ...interaction.values])];
        setCommandRoles(interaction.guild.id, command, combined);
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }
    }

    if (interaction.isChannelSelectMenu()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed("Only administrators can change setup.")], ephemeral: true });
      }

      if (interaction.customId === "setup_blacklist_channel") {
        db.prepare(`UPDATE settings SET blacklist_channel_id = ? WHERE guild_id = ?`).run(interaction.values[0], interaction.guild.id);
        return interaction.update({ embeds: [publicEmbed("📢 Channel Setup", "✅ Blacklist log channel saved.\n\nNow choose the unblacklist channel.", 0x57F287)], components: channelSelects() });
      }

      if (interaction.customId === "setup_unblacklist_channel") {
        db.prepare(`UPDATE settings SET unblacklist_channel_id = ? WHERE guild_id = ?`).run(interaction.values[0], interaction.guild.id);
        return interaction.update({ embeds: [publicEmbed("📢 Channel Setup", "✅ Unblacklist log channel saved.\n\nNow choose the join ping channel.", 0x57F287)], components: channelSelects() });
      }

      if (interaction.customId === "setup_auto_ping_channel") {
        const channelId = interaction.values[0];
        setAutoPingChannel(interaction.guild.id, channelId, true);
        return interaction.update({ embeds: [setupSummary(interaction.guild.id)], components: setupControls() });
      }

      if (interaction.customId === "setup_log_channel_select") {
        db.prepare(`UPDATE settings SET log_channel_id = ? WHERE guild_id = ?`).run(interaction.values[0], interaction.guild.id);
        const panel = logSetupPanel(interaction.guild.id);
        return interaction.update({ embeds: [panel.embed], components: panel.components });
      }
    }
  } catch (error) {
    const interactionContext = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.customId || "unknown interaction";
    console.error(`Interaction error (${interactionContext}):`, error);

    if (interaction.isRepliable()) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const embed = errorEmbed(`\`${interactionContext}\` failed.\n\n${safeText(errorMessage).slice(0, 800)}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [embed], ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
      }
    }
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;

  const honeypot = db.prepare("SELECT channel_id FROM honeypot_settings WHERE guild_id = ?").get(message.guild.id);
  if (honeypot?.channel_id === message.channelId) {
    const member = message.member;
    const isBypass = canBypassHoneypot(member);

    if (isBypass) {
      return;
    }

    try {
      await message.delete();
    } catch (error) {
      console.warn(`Could not delete a honeypot message in ${message.guild.name}:`, error.message);
    }

    if (member) {
      try {
        await member.kick("Posted in the honeypot channel");

        try {
          await member.send({
            embeds: [publicEmbed("🍯 Honeypot Triggered", `You were kicked from **${message.guild.name}** because you posted in the honeypot channel. Do not send messages there again.`, 0xED4245)]
          });
        } catch (dmError) {
          console.warn(`Could not DM ${member.user.tag} after honeypot kick:`, dmError.message);
        }
      } catch (error) {
        console.warn(`Could not kick ${member.user.tag} for posting in the honeypot channel:`, error.message);
      }
    }

    return;
  }

  const prefixes = getPrefixes(message.guild.id);
  if (!prefixes.length) return;

  const prefix = prefixes.find(p => message.content.startsWith(p));
  if (!prefix) return;

  const input = message.content.slice(prefix.length).trim();
  if (!input) return;

  const args = input.split(/\s+/);
  const command = args.shift().toLowerCase();

  if (!COMMANDS.includes(command)) return;

  if (command === "help") {
    return message.reply({ embeds: [helpEmbed()] });
  }

  if (command === "serverinfo") {
    return message.reply({ embeds: [serverInfoEmbed(message.guild)] });
  }

  if (command === "userinfo") {
    const memberId = args[0]?.replace(/[<@!>]/g, "");
    const member = memberId
      ? await message.guild.members.fetch(memberId).catch(() => null)
      : message.member;
    if (!member) return message.reply({ embeds: [errorEmbed("That user is not a member of this server.")] });
    return message.reply({ embeds: [userInfoEmbed(member)] });
  }

  const deletingStrike = command === "strike" && args[0]?.toLowerCase() === "delete";
  if (!hasCommandAccess(message, command) &&
      !(deletingStrike && canActivateSecurityCommand(message.guild, message.member))) {
    return message.reply({ embeds: [errorEmbed("You don't have permission to use this command.")] });
  }

  if (command === "lock" || command === "unlock") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({ embeds: [errorEmbed(`You need the Manage Channels permission to use \`${prefix}${command}\`.`)] });
    }

    const result = await setChannelLock(message.guild, message.channel, command === "lock");
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });

    const action = result.locked ? "locked" : "unlocked";
    return message.reply({ embeds: [publicEmbed(`🔒 Channel ${action}`, `${result.channel} has been ${action} for @everyone.`, result.locked ? 0xED4245 : 0x57F287)] });
  }

  if (command === "slowmode") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({ embeds: [errorEmbed(`You need the Manage Channels permission to use \`${prefix}slowmode\`.`)] });
    }

    const seconds = Number.parseInt(args[0], 10);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}slowmode <seconds 0-21600> [reason]\``)] });
    }

    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(message.channel.type)) {
      return message.reply({ embeds: [errorEmbed("Slowmode can only be changed in a text or announcement channel.")] });
    }

    const botPermissions = message.channel.permissionsFor(message.guild.members.me);
    if (!botPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({ embeds: [errorEmbed("I need the Manage Channels permission in this channel to change slowmode.")] });
    }

    const reason = args.slice(1).join(" ") || `Changed by ${message.author.tag}`;
    try {
      await message.channel.setRateLimitPerUser(seconds, reason);
      addModLog(message.guild.id, "slowmode", message.author.id, message.author.id, reason);
      const result = seconds === 0 ? "disabled" : `set to ${seconds} second(s)`;
      return message.reply({ embeds: [publicEmbed("🐢 Slowmode Updated", `Slowmode in ${message.channel} was ${result}.`, 0x57F287)] });
    } catch (error) {
      console.error("Prefix slowmode update failed:", error);
      return message.reply({ embeds: [errorEmbed("I couldn't update slowmode. Check my channel permissions and try again.")] });
    }
  }

  if (command === "warn") {
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(" ");

    if (!target || !reason) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}warn @user reason\``)] });
    }

    const result = db.prepare(`
      INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(message.guild.id, target.id, message.author.id, reason, now());

    addModLog(message.guild.id, "warn", target.id, message.author.id, reason);

    let dmStatus = "❌ Failed";
    try {
      await target.send({
        embeds: [publicEmbed("⚠️ You Have Been Warned", `You were warned in **${message.guild.name}** by ${userMention(message.author.id)}.`, 0xFEE75C).addFields(
          { name: "📝 Reason", value: safeText(reason) },
          { name: "🏠 Server", value: message.guild.name, inline: true },
          { name: "👮 Moderator", value: userMention(message.author.id), inline: true }
        )]
      });
      dmStatus = "✅ Sent";
    } catch {
      dmStatus = "❌ Failed (DMs may be disabled)";
    }

    return message.reply({
      embeds: [publicEmbed("⚠️ User Warned", `${userMention(target.id)} has received a warning.`, 0xFEE75C).addFields(
        { name: "⚠️ Warning ID", value: `#${result.lastInsertRowid}`, inline: true },
        { name: "👮 Moderator", value: userMention(message.author.id), inline: true },
        { name: "📝 Reason", value: safeText(reason) },
        { name: "📩 DM Status", value: dmStatus, inline: true }
      )]
    });
  }

  if (command === "warns") {
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}warns @user\``)] });

    const warnings = db.prepare(`
      SELECT *
      FROM warnings
      WHERE guild_id = ?
      AND user_id = ?
      ORDER BY id DESC
    `).all(message.guild.id, target.id);

    if (!warnings.length) {
      return message.reply({ embeds: [publicEmbed("⚠️ Warnings", `${userMention(target.id)} has no warnings.`, 0x57F287)] });
    }

    const embed = publicEmbed("⚠️ User Warnings", `${userMention(target.id)} has **${warnings.length}** warning(s).`, 0xFEE75C);
    for (const warning of warnings.slice(0, 25)) {
      embed.addFields({ name: `Warning #${warning.id}`, value: `**Reason:** ${safeText(warning.reason)}\n**Moderator:** ${userMention(warning.moderator_id)}\n**Date:** ${timestamp(warning.created_at)}` });
    }

    return message.reply({ embeds: [embed] });
  }

  if (command === "kick") {
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(" ");

    if (!target || !reason) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}kick @user reason\``)] });
    }

    if (!canModerateMember(message.guild, message.member, target)) {
      return message.reply({ embeds: [errorEmbed("That user is higher than you in the hierarchy.")] });
    }

    const botMember = message.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.KickMembers)) {
      return message.reply({ embeds: [errorEmbed("I need the Kick Members permission.")] });
    }

    try {
      await target.kick(reason || "No reason provided");
    } catch (error) {
      console.error("Kick failed:", error);
      return message.reply({ embeds: [errorEmbed("I couldn't kick that user.")] });
    }

    addModLog(message.guild.id, "kick", target.id, message.author.id, reason || "No reason provided");
    return message.reply({ embeds: [publicEmbed("👢 User Kicked", `${userMention(target.id)} was kicked.`, 0xED4245).addFields(
      { name: "👤 User", value: userMention(target.id), inline: true },
      { name: "👮 Moderator", value: userMention(message.author.id), inline: true },
      { name: "📝 Reason", value: safeText(reason || "No reason provided") }
    )] });
  }

  if (command === "case") {
    const caseId = Number.parseInt(args[0], 10);
    if (!caseId) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}case <case_number>\``)] });

    const record = db.prepare(`
      SELECT *
      FROM blacklist_records
      WHERE guild_id = ?
      AND case_number = ?
    `).get(message.guild.id, caseId);

    if (!record) {
      return message.reply({ embeds: [errorEmbed(`I couldn't find blacklist case #${caseId}.`)] });
    }

    return message.reply({ embeds: [blacklistCaseEmbed(record)] });
  }

  if (command === "editcase") {
    const caseId = Number.parseInt(args[0], 10);
    const newReason = args.slice(1).join(" ");
    if (!caseId || !newReason) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}editcase <case_number> <new_reason>\``)] });
    if (newReason.length > 1000) return message.reply({ embeds: [errorEmbed("The updated reason must be 1,000 characters or fewer.")] });

    const existing = db.prepare(`
      SELECT *
      FROM blacklist_records
      WHERE guild_id = ?
      AND case_number = ?
    `).get(message.guild.id, caseId);

    if (!existing) {
      return message.reply({ embeds: [errorEmbed(`I couldn't find blacklist case #${caseId}.`)] });
    }

    db.prepare(`
      UPDATE blacklist_records
      SET reason = ?
      WHERE guild_id = ?
      AND case_number = ?
    `).run(newReason, message.guild.id, caseId);

    const updated = db.prepare(`
      SELECT *
      FROM blacklist_records
      WHERE guild_id = ?
      AND case_number = ?
    `).get(message.guild.id, caseId);

    return message.reply({ embeds: [blacklistCaseEmbed(updated, "✏️ Blacklist Case Updated", `Updated blacklist case #${updated.case_number}.`)] });
  }

  if (command === "raid") {
    const mode = args[0]?.toLowerCase();
    if (!["on", "off", "true", "false", "1", "0"].includes(mode)) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}raid <on|off>\``)] });
    }
    const enabled = ["on", "true", "1"].includes(mode);
    if (!canActivateSecurityCommand(message.guild, message.member)) {
      return message.reply({ embeds: [errorEmbed("Only a member above the bot can activate raid protection.")] });
    }

    if (enabled) {
      raidProtectionUntil.set(message.guild.id, Date.now() + (24 * 60 * 60 * 1000));
      return message.reply({ embeds: [publicEmbed("🛡️ Raid Protection Enabled", "Raid protection has been activated for this server. A member above the bot can disable it later.", 0xED4245)] });
    }

    raidProtectionUntil.delete(message.guild.id);
    return message.reply({ embeds: [publicEmbed("🛡️ Raid Protection Disabled", "Raid protection has been disabled for this server.", 0x57F287)] });
  }

  if (command === "unmute") {
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(" ");
    if (!target || !reason) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}unmute @user reason\``)] });

    const result = await doUnmute(message.guild, message.member, target, reason);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });
    return message.reply({ embeds: [result.embed] });
  }

  if (command === "blacklist") {
    const target = message.mentions.members.first();
    const category = args[1];
    const reason = args.slice(2).join(" ");

    if (!target || !category || !reason) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}blacklist @user category reason\``)] });
    }

    const result = await doBlacklist(message.guild, message.member, target, category, reason);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });

    await message.reply({ embeds: [result.embed] });

    const settings = getSettings(message.guild.id);
    if (settings.blacklist_channel_id) {
      const channel = message.guild.channels.cache.get(settings.blacklist_channel_id);
      if (channel && channel.isTextBased()) await channel.send({ embeds: [result.embed] }).catch(() => {});
    }

    return;
  }

  if (command === "blacklistlist") {
    const page = Number.parseInt(args[0], 10) || 1;
    const result = blacklistListEmbed(message.guild.id, page);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });
    return message.reply({
      content: result.mentionContent,
      embeds: [result.embed],
      components: result.components || [],
      allowedMentions: { users: result.moderatorIds || [] }
    });
  }

  if (command === "strike") {
    const action = args[0]?.toLowerCase() === "delete" ? "delete" : "add";
    const strikeArgs = ["add", "delete"].includes(args[0]?.toLowerCase()) ? args.slice(1) : args;
    const target = message.mentions.members.first();
    if (!target) {
      const usage = action === "delete"
        ? `${prefix}strike delete @user`
        : `${prefix}strike add @user reason`;
      return message.reply({ embeds: [errorEmbed(`Usage: \`${usage}\``)] });
    }

    if (!canActivateSecurityCommand(message.guild, message.member)) {
      return message.reply({ embeds: [errorEmbed("You must have a role above the bot to use strike commands.")] });
    }

    if (action === "delete") {
      const result = strikeDeleteSelection(message.guild.id, target.id);
      return message.reply({ embeds: [result.embed], components: result.components });
    }

    if (target.user.bot) {
      return message.reply({ embeds: [errorEmbed("Staff strikes can only be given to people, not bots.")] });
    }
    if (!canModerateMember(message.guild, message.member, target)) {
      return message.reply({ embeds: [errorEmbed("You can only give a strike to a member below you in the role hierarchy.")] });
    }

    const reason = strikeArgs.filter(argument => !message.mentions.users.has(argument.replace(/[<@!>]/g, ""))).join(" ").trim();
    if (!reason) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}strike add @user reason\``)] });

    const result = db.transaction(() => {
      const count = db.prepare(`
        SELECT COUNT(*) AS count
        FROM staff_strikes
        WHERE guild_id = ? AND user_id = ?
      `).get(message.guild.id, target.id).count;
      if (count >= 3) return { error: "That staff member already has the maximum of 3/3 strikes." };

      const createdAt = now();
      db.prepare(`
        INSERT INTO staff_strikes (guild_id, user_id, moderator_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(message.guild.id, target.id, message.author.id, reason, createdAt);
      return { count: count + 1, createdAt };
    })();
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });

    addModLog(message.guild.id, "staffstrike", target.id, message.author.id, reason);
    let dmStatus = "❌ Failed (DMs may be disabled)";
    try {
      await target.send({
        embeds: [publicEmbed(
          "⚠️ You Received a Staff Strike",
          `You received a staff strike in **${safeText(message.guild.name)}** from ${userMention(message.author.id)}.`,
          0xFEE75C
        ).addFields(
          { name: "Strike Count", value: `${result.count}/3`, inline: true },
          { name: "Reason", value: safeText(reason) }
        )]
      });
      dmStatus = "✅ Sent";
    } catch (error) {
      console.warn(`Could not DM ${target.user.tag} about staff strike:`, error.message);
    }

    return message.reply({
      embeds: [publicEmbed(
        "⚠️ Staff Strike Given",
        `${userMention(target.id)} now has **${result.count}/3** staff strikes.`,
        result.count >= 3 ? 0xED4245 : 0xFEE75C
      ).addFields(
        { name: "Reason", value: safeText(reason) },
        { name: "Given By", value: userMention(message.author.id), inline: true },
        { name: "Date", value: timestamp(result.createdAt), inline: true },
        { name: "DM Status", value: dmStatus, inline: true }
      )]
    });
  }

  if (command === "strikecheck") {
    if (!canActivateSecurityCommand(message.guild, message.member)) {
      return message.reply({ embeds: [errorEmbed("You must have a role above the bot to check staff strikes.")] });
    }

    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}strikecheck @user\``)] });

    const strikes = db.prepare(`
      SELECT id, moderator_id, reason, created_at,
        ROW_NUMBER() OVER (ORDER BY id ASC) AS strike_number
      FROM staff_strikes
      WHERE guild_id = ? AND user_id = ?
      ORDER BY id ASC
    `).all(message.guild.id, target.id);
    return message.reply({ embeds: [staffStrikeEmbed(target, strikes)] });
  }

  if (command === "strikelist") {
    if (!canActivateSecurityCommand(message.guild, message.member)) {
      return message.reply({ embeds: [errorEmbed("You must have a role above the bot to use this command.")] });
    }

    const page = Number.parseInt(args[0], 10) || 1;
    const result = staffStrikeListEmbed(message.guild.id, page);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });
    return message.reply({ embeds: [result.embed], components: result.components });
  }

  if (command === "unblacklist") {
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(" ");
    if (!target || !reason) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}unblacklist @user reason\``)] });

    const result = await doUnblacklist(message.guild, message.member, target, reason);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });

    await message.reply({ embeds: [result.embed] });

    const settings = getSettings(message.guild.id);
    if (settings.unblacklist_channel_id) {
      const channel = message.guild.channels.cache.get(settings.unblacklist_channel_id);
      if (channel && channel.isTextBased()) await channel.send({ embeds: [result.embed] }).catch(() => {});
    }

    return;
  }

  if (command === "mute") {
    const target = message.mentions.members.first();
    const duration = args[1];
    const reason = args.slice(2).join(" ") || "No reason provided";

    if (!target || !duration) {
      return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}mute @user 10m [reason]\``)] });
    }

    const result = await doMute(message.guild, message.member, target, duration, reason);
    if (result.error) return message.reply({ embeds: [errorEmbed(result.error)] });

    return message.reply({ embeds: [result.embed] });
  }

  if (command === "modlogs") {
    const moderator = message.mentions.members.first();
    if (!moderator) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}modlogs @moderator\``)] });

    return message.reply({ embeds: [modlogsEmbed(message.guild.id, moderator.id)] });
  }

  if (command === "blacklistcheck") {
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}blacklistcheck @user\``)] });

    const record = db.prepare(`
      SELECT *
      FROM blacklist_records
      WHERE guild_id = ?
      AND user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(message.guild.id, target.id);

    if (!record) {
      return message.reply({ embeds: [publicEmbed("🔎 Blacklist Check", `${userMention(target.id)} has no blacklist record.`, 0x57F287)] });
    }

    return message.reply({
      embeds: [publicEmbed("🔎 Blacklist Check", `${userMention(target.id)} blacklist record.`, record.active ? 0xED4245 : 0x57F287).addFields(
        { name: "Status", value: record.active ? "⛔ Active" : "✅ Inactive", inline: true },
        { name: "Category", value: record.category, inline: true },
        { name: "Roles Stored", value: String(record.roles_count), inline: true },
        { name: "Reason", value: safeText(record.reason) },
        { name: "Moderator", value: userMention(record.moderator_id), inline: true },
        { name: "Date", value: timestamp(record.created_at), inline: true }
      )]
    });
  }
});

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  try {
    await handleAntiNukeAuditEntry(entry, guild);
  } catch (error) {
    console.error("Anti-nuke audit handler error:", error);
  }
  try {
    await logServerAuditEntry(entry, guild);
  } catch (error) {
    console.error("Server audit log handler error:", error);
  }
});

client.on("guildMemberAdd", async member => {
  try {
    await handleRaidJoin(member);
    await logGuildEvent(member.guild, "👋 Member Joined", `${userMention(member.id)} joined the server.`, 0x5865F2, "members");

    const settings = getSettings(member.guild.id);
    if (settings.auto_ping_enabled && settings.auto_ping_channel_id) {
      const channel = member.guild.channels.cache.get(settings.auto_ping_channel_id);
      const botPermissions = channel?.permissionsFor(member.guild.members.me);
      if (channel && channel.isTextBased() && channel.viewable && botPermissions?.has(PermissionFlagsBits.SendMessages)) {
        const pingMessage = await channel.send({
          content: `<@${member.id}>`,
          allowedMentions: { users: [member.id] }
        }).catch(error => {
          console.warn(`Could not send the join ghost-ping in ${member.guild.name}:`, error.message);
          return null;
        });

        if (pingMessage) {
          setTimeout(() => {
            pingMessage.delete().catch(error => {
              console.warn(`Could not delete the join ghost-ping in ${member.guild.name}:`, error.message);
            });
          }, GHOST_PING_DELAY_MS);
        }
      } else if (channel) {
        console.warn(`Cannot send the join ghost-ping in ${member.guild.name}; check View Channel and Send Messages permissions in ${channel.name}.`);
      }
    }

    const record = db.prepare(`
      SELECT *
      FROM blacklist_records
      WHERE guild_id = ?
      AND user_id = ?
      AND active = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(member.guild.id, member.id);

    if (record) {
      const blacklistRole = member.guild.roles.cache.find(role => role.name === BLACKLIST_ROLE_NAME);
      if (blacklistRole && blacklistRole.editable) {
        await member.roles.add(blacklistRole).catch(() => {});
      }
    }
  } catch (error) {
    console.error("guildMemberAdd error:", error);
  }
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const previousTimeout = oldMember.communicationDisabledUntilTimestamp;
  const currentTimeout = newMember.communicationDisabledUntilTimestamp;
  const settings = getSettings(newMember.guild.id);
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

  if (addedRoles.size || removedRoles.size) {
    const legacyLogUsesAuditChannel = settings.server_logs_enabled &&
      settings.log_channel_id &&
      settings.log_channel_id === settings.server_log_channel_id;
    if (!legacyLogUsesAuditChannel) {
      const logText = [];
      if (addedRoles.size) logText.push(`Added: ${addedRoles.map(role => role.name).join(", ")}`);
      if (removedRoles.size) logText.push(`Removed: ${removedRoles.map(role => role.name).join(", ")}`);
      await logGuildEvent(newMember.guild, "🧩 Role Update", `${userMention(newMember.id)}\n${logText.join("\n")}`, 0x5865F2, "roles");
    }
  }

  if (oldMember.nickname !== newMember.nickname) {
    const legacyNicknameLogging = settings.log_channel_id &&
      getEnabledLogEvents(settings).includes("member_updates");
    const serverLogsEnabled = settings.server_logs_enabled && settings.server_log_channel_id;
    const legacyLogUsesAuditChannel = serverLogsEnabled &&
      legacyNicknameLogging &&
      settings.log_channel_id === settings.server_log_channel_id;
    if (legacyNicknameLogging && !legacyLogUsesAuditChannel) {
      const auditEntry = await findRecentAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
      const before = oldMember.nickname || oldMember.user.username;
      const after = newMember.nickname || newMember.user.username;
      const actor = auditEntry?.executorId ? userMention(auditEntry.executorId) : "Unavailable";
      const auditId = auditEntry ? auditEntry.id : "Unavailable";
      await logGuildEvent(
        newMember.guild,
        "✏️ Member Nickname Changed",
        `${userMention(newMember.id)}\nBefore: ${safeText(before)}\nAfter: ${safeText(after)}\nChanged by: ${actor}\nAudit Entry ID: ${auditId}`,
        0x5865F2,
        "member_updates"
      );
    }
  }

  if (!previousTimeout || previousTimeout > Date.now()) return;
  if (currentTimeout && currentTimeout > Date.now()) return;
  if (currentTimeout === previousTimeout) return;

  await newMember.send(`Your timeout in **${newMember.guild.name}** has ended. You can now send messages and interact in the server again.`)
    .catch(error => console.warn(`Could not DM ${newMember.user.tag} about their expired timeout:`, error.message));
});

client.on("guildMemberRemove", async member => {
  await logGuildEvent(member.guild, "🚪 Member Left", `${userMention(member.id)} left the server.\nJoined: ${timestamp(member.joinedAt?.getTime?.() || Date.now())}`, 0x5865F2, "members");
});

client.on("guildBanAdd", async (ban) => {
  const settings = getSettings(ban.guild.id);
  if (settings.server_logs_enabled && settings.server_log_channel_id === settings.log_channel_id) return;
  await logGuildEvent(ban.guild, "🔒 Member Banned", `${userMention(ban.user.id)} was banned.\nReason: ${safeText(ban.reason || "No reason provided")}`, 0x5865F2, "bans");
});

client.on("guildBanRemove", async (ban) => {
  const settings = getSettings(ban.guild.id);
  if (settings.server_logs_enabled && settings.server_log_channel_id === settings.log_channel_id) return;
  await logGuildEvent(ban.guild, "✅ Member Unbanned", `${userMention(ban.user.id)} was unbanned.`, 0x5865F2, "bans");
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    const botPermissions = guild.members.me?.permissions;
    const missingPermissions = [];
    if (!botPermissions?.has(PermissionFlagsBits.ViewAuditLog)) missingPermissions.push("View Audit Log");
    if (!botPermissions?.has(PermissionFlagsBits.ManageRoles)) missingPermissions.push("Manage Roles");
    if (!botPermissions?.has(PermissionFlagsBits.ModerateMembers)) missingPermissions.push("Moderate Members");
    if (missingPermissions.length) {
      console.warn(`Anti-nuke/raid protection is limited in ${guild.name}; grant the bot: ${missingPermissions.join(", ")}.`);
    }
  }

  try {
    await registerCommands();
  } catch (error) {
    console.error("❌ Command registration failed:", error);
  }
});

client.login(TOKEN);
