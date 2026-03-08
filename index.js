// ==============================
// Folytyn's Family Middleman Bot
// index.js — PART 1 / 3
// Core setup, config, database, helpers
// ==============================

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const Database = require("better-sqlite3");
const ms = require("ms");

// node-fetch v3 workaround:
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

require("dotenv").config();
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = ":";
const OWNER_ID = "1150098026589855794";

// ---- Client (intents needed for prefix commands + role management) ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // role add/remove
    GatewayIntentBits.GuildMessages,     // prefix commands
    GatewayIntentBits.MessageContent,    // prefix commands
  ],
  partials: [Partials.Channel],
});

// ---- DB ----
const db = new Database("./Crosstrading Island MM.sqlite");

// guild settings
db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  request_channel_id TEXT,
  ticket_category_id TEXT,
  mm_role_id TEXT,
  log_channel_id TEXT,
  protected_role_client_id TEXT,
  protected_role_members_id TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  owner_id TEXT,
  other_id TEXT,
  tier_key TEXT,
  tip TEXT,
  side TEXT,
  details TEXT,
  claimed_by TEXT,
  created_at INTEGER,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS trips (
  guild_id TEXT,
  user_id TEXT,
  end_at INTEGER,
  saved_roles TEXT,
  PRIMARY KEY (guild_id, user_id)
);
`);

const stmtGetSettings = db.prepare(`SELECT * FROM guild_settings WHERE guild_id=?`);
const stmtUpsertSettings = db.prepare(`
INSERT INTO guild_settings (
  guild_id, request_channel_id, ticket_category_id, mm_role_id, log_channel_id,
  protected_role_client_id, protected_role_members_id
) VALUES (
  @guild_id, @request_channel_id, @ticket_category_id, @mm_role_id, @log_channel_id,
  @protected_role_client_id, @protected_role_members_id
)
ON CONFLICT(guild_id) DO UPDATE SET
  request_channel_id=excluded.request_channel_id,
  ticket_category_id=excluded.ticket_category_id,
  mm_role_id=excluded.mm_role_id,
  log_channel_id=excluded.log_channel_id,
  protected_role_client_id=excluded.protected_role_client_id,
  protected_role_members_id=excluded.protected_role_members_id
`);

const stmtInsertTicket = db.prepare(`
INSERT INTO tickets (ticket_channel_id, guild_id, owner_id, other_id, tier_key, tip, side, details, claimed_by, created_at, closed_at)
VALUES (@ticket_channel_id, @guild_id, @owner_id, @other_id, @tier_key, @tip, @side, @details, @claimed_by, @created_at, @closed_at)
`);

const stmtGetTicket = db.prepare(`SELECT * FROM tickets WHERE ticket_channel_id=?`);
const stmtUpdateTicketClaim = db.prepare(`UPDATE tickets SET claimed_by=? WHERE ticket_channel_id=?`);
const stmtCloseTicket = db.prepare(`UPDATE tickets SET closed_at=? WHERE ticket_channel_id=?`);

const stmtUpsertTrip = db.prepare(`
INSERT INTO trips (guild_id, user_id, end_at, saved_roles)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, user_id) DO UPDATE SET
  end_at=excluded.end_at,
  saved_roles=excluded.saved_roles
`);
const stmtGetTrip = db.prepare(`SELECT * FROM trips WHERE guild_id=? AND user_id=?`);
const stmtDeleteTrip = db.prepare(`DELETE FROM trips WHERE guild_id=? AND user_id=?`);
const stmtAllTrips = db.prepare(`SELECT * FROM trips`);

// ---- In-memory timers (recreated on startup from DB) ----
const tripTimers = new Map(); // key: guildId:userId -> timeout

// ---- Solara-style tiers (edit text here if you want later) ----
const TIERS = [
  { key: "t1", label: "0–150M Trade Value", desc: "$1–30 USD" },
  { key: "t2", label: "150M–500M Trade Value", desc: "$30–60 USD" },
  { key: "t3", label: "500M–1B Trade Value", desc: "$60–100 USD" },
  { key: "t4", label: "OG Trade Value", desc: "$100+ USD" },
];

function tierByKey(key) {
  return TIERS.find(t => t.key === key) || TIERS[0];
}

function getSettingsOrNull(guildId) {
  return stmtGetSettings.get(guildId) || null;
}

function mustBeSetup(settings) {
  return (
    settings &&
    settings.request_channel_id &&
    settings.ticket_category_id &&
    settings.mm_role_id &&
    settings.log_channel_id &&
    settings.protected_role_client_id &&
    settings.protected_role_members_id
  );
}

async function logToGuild(guild, settings, message) {
  try {
    const ch = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
    if (!ch) return;
    await ch.send({ content: message });
  } catch {}
}

function safeUserTag(user) {
  return user?.tag ? user.tag : `${user?.username || "Unknown"}#????`;
}

function parseDuration(input) {
  // accepts: 2h, 30m, 1d, 90m, etc.
  const val = ms(input);
  return typeof val === "number" && val > 0 ? val : null;
}

async function restoreTrip(guild, settings, member, savedRoleIds) {
  // Restore saved roles exactly (except protected ones will already be present anyway)
  const protectedSet = new Set([settings.protected_role_client_id, settings.protected_role_members_id]);

  // Filter out roles that no longer exist
  const existing = savedRoleIds.filter(rid => guild.roles.cache.has(rid));

  // Always keep the protected ones
  for (const rid of protectedSet) {
    if (guild.roles.cache.has(rid) && !existing.includes(rid)) existing.push(rid);
  }

  await member.roles.set(existing, "Trip ended (restore roles)");
}

function scheduleTripEnd(guildId, userId, endAt) {
  const key = `${guildId}:${userId}`;
  if (tripTimers.has(key)) clearTimeout(tripTimers.get(key));

  const delay = Math.max(0, endAt - Date.now());
  const t = setTimeout(async () => {
    tripTimers.delete(key);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const settings = getSettingsOrNull(guildId);
    if (!mustBeSetup(settings)) return;

    const trip = stmtGetTrip.get(guildId, userId);
    if (!trip) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      stmtDeleteTrip.run(guildId, userId);
      return;
    }

    const saved = JSON.parse(trip.saved_roles || "[]");
    await restoreTrip(guild, settings, member, saved).catch(() => null);
    stmtDeleteTrip.run(guildId, userId);

    await logToGuild(guild, settings, `✅ Trip ended — restored roles for <@${userId}>`);
  }, delay);

  tripTimers.set(key, t);
}

// ---- Startup: restore trip timers ----
client.once("ready", async () => {
  console.log(`✅ Logged in as ${safeUserTag(client.user)}`);
  for (const trip of stmtAllTrips.all()) {
    scheduleTripEnd(trip.guild_id, trip.user_id, trip.end_at);
  }
});

// ==============================
// PART 2/3 starts below
// ==============================
// ==============================
// index.js — PART 2 / 3
// :help dropdown menus (Solara-style)
// ==============================

function helpMainEmbed() {
  return new EmbedBuilder()
    .setColor(0x5b2cff)
    .setTitle("🤖 Bot Command Center")
    .setDescription("Select a category below to view the full command list.")
    .addFields(
      { name: "🛡 Staff, Admin & Trip", value: "Mod, Admin, Trip tools", inline: false },
      { name: "🛠 Utility & Time", value: "Pingtime, Crypto, Guides", inline: false },
      { name: "📦 Middleman / Tickets", value: "MM request + ticket tools", inline: false },
    )
    .setImage("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")     // BIG banner image
    .setThumbnail("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")  // Small logo (top-right)
    .setFooter({ text: "Use the menu to switch categories." });
}

function helpSelectRow(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Select a category…")
      .addOptions(
        {
          label: "Staff, Admin & Trip",
          description: "Moderation, management, trip tools",
          value: "staff",
          emoji: "🛡️",
        },
        {
          label: "Utility & Time",
          description: "General tools, timezones, crypto, info",
          value: "utility",
          emoji: "🛠",
        },
        {
          label: "Middleman / Tickets",
          description: "MM panel, tickets, manual controls",
          value: "mm",
          emoji: "🎫",
        },
      )
  );
}

function helpStaffEmbed(prefix) {
  return new EmbedBuilder()
    .setColor(0x5b2cff)
    .setTitle("🧑‍✈️ Staff, Admin & Trip")
    .setDescription("Moderation, punishment, and control commands.")
    .addFields(
      {
      name: "Commands",
      value:
        `\`${prefix}stfu @user [minutes]\` — Timeout a user\n` +
        `\`${prefix}zap @user\` — Kick a user\n` +
        `\`${prefix}unzap @user\` — Re-invite / acknowledge return\n` +
        `\`${prefix}bye @user\` — Ban a user with message\n` +
        `\`${prefix}unbye @user\` — Revoke ban message\n` +
        `\`${prefix}demote @user\` — Strip roles\n` +
        `\`${prefix}say <text>\` — Owner broadcast`
    }
    )
    .setFooter({ text: "Use the menu to switch categories." });
}



function helpUtilityEmbed(prefix) {
  return new EmbedBuilder()
    .setTitle("🛠 Utility & Time")
    .setDescription("*General tools, timezones, and info.*")
    .addFields({
      name: "Commands",
      value:
        `\`${prefix}pingtime\` — Check latency & basic time info\n` +
        `\`${prefix}search <coin>\` — Search crypto market data\n` +
        `\`${prefix}avatar [user]\` — View full-size avatar\n` +
        `\`${prefix}serverinfo\` — View server stats\n` +
        `\`${prefix}howto\` — View server guides/tutorials`,
    })
    .setFooter({ text: "Use the menu to switch categories." });
}

function helpMMEmbed(prefix) {
  return new EmbedBuilder()
    .setTitle("🎫 Middleman / Tickets")
    .setDescription("*Middleman request panel + ticket tools.*")
    .addFields({
      name: "Commands",
      value:
        `\`${prefix}mmsetup <requestChannelId> <ticketCategoryId> <mmRoleId> <logChannelId> <clientRoleId> <membersRoleId>\`\n` +
        `\`${prefix}postmm\` — Post MM request panel\n` +
        `\`${prefix}claim\` — Claim ticket (manual)\n` +
        `\`${prefix}unclaim\` — Unclaim ticket (manual)\n` +
        `\`${prefix}adduser @user\` — Add user to ticket (manual)\n` +
        `\`${prefix}close\` — Close ticket (manual)\n`,
    })
    .setFooter({ text: "Use the menu to switch categories." });
}

// Handle help menu interactions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "help_menu") return;

  const choice = interaction.values?.[0];
  let embed;

  if (choice === "staff") embed = helpStaffEmbed(PREFIX);
  else if (choice === "utility") embed = helpUtilityEmbed(PREFIX);
  else embed = helpMMEmbed(PREFIX);

  await interaction.update({ embeds: [embed], components: [helpSelectRow("help_menu")] }).catch(() => null);
});
// ==============================
// PART 3/3 starts below
// ==============================
// ==============================
// index.js — PART 3 / 3
// Tickets system, buttons, modals, manual commands, trip/demote, utility
// ==============================

function mmPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5b2cff)
    .setTitle("🔒 Crosstrading Island — Middleman Service")
    .setDescription(
      "**Secure • Trusted • Professional**\n\n" +
      "Select a trade value range below to open an MM ticket."
    )

    // 🔹 BIG IMAGE (banner)
    .setImage("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")

    // 🔹 SMALL IMAGE (thumbnail / logo)
    .setThumbnail("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")

    .setFooter({ text: "Select your trade value range…" });
}
function mmTierRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mm_tier_select")
    .setPlaceholder("Select your trade value range…")
    .addOptions(
      TIERS.map(t => ({
        label: t.label,
        description: t.desc,
        value: t.key,
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function ticketButtonsRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId("ticket_unclaim").setLabel("Unclaim").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId("ticket_adduser").setLabel("Add User").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function ticketEmbed(data, guild) {
  const tier = tierByKey(data.tier_key);

  const trader = `<@${data.owner_id}>`;
  const other = data.other_id ? `<@${data.other_id}>` : "*Not added yet*";

  const claimed = data.claimed_by ? `<@${data.claimed_by}>` : "*Unclaimed*";
return new EmbedBuilder()
  .setTitle("📨 Crosstrading Island MM Ticket")
  .setDescription("Ticket created. Please wait for a middleman.")
 .addFields(
    { name: "👤 Trader", value: trader, inline: false },
    { name: "🤝 Other Trader", value: other, inline: false },
    { name: "📦 Trade Details", value: data.details?.slice(0, 1024) || "*None*", inline: false },
    { name: "📌 Your Side", value: data.side || "*Not set*", inline: true },
    { name: "💎 Tier", value: `${tier.label}\n${tier.desc}`, inline: true },
    { name: "💰 Tip (20%)", value: data.tip || "*None*", inline: true },
    { name: "🧑‍⚖️ Claimed By", value: claimed, inline: false },
  )
  .setThumbnail("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")
  .setImage("https://cdn.discordapp.com/attachments/1466853374455451648/1480034437059051723/a_6c9232b135b3aff9aba58a5ae1e0f3cb.gif?ex=69ae34fb&is=69ace37b&hm=0b529a4ef52cd6bc302cc8b98456c43423c2f96ad834eb4f168e7ec868a4d20e&")
  .setFooter({ text: "Use buttons below — or manual commands if needed." });
}
function mustHaveManageChannels(member) {
  return member.permissions.has(PermissionsBitField.Flags.ManageChannels);
}
async function createTicketChannel(guild, settings, ownerMember, otherId, tierKey) {
  const category = await guild.channels.fetch(settings.ticket_category_id).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  const mmRoleId = settings.mm_role_id;

  // ticket channel name: ticket-username####
  const base = (ownerMember.user.username || "user").toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = Math.floor(1000 + Math.random() * 9000);
  const name = `ticket-${base}${suffix}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: ownerMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: mmRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] },
  ];

  if (otherId) {
    overwrites.push({ id: otherId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  }

  const ch = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    reason: "MM ticket created",
  }).catch(() => null);

  return ch;
}

function buildTicketModal(tierKey) {
  const tier = tierByKey(tierKey);

  const modal = new ModalBuilder()
    .setCustomId(`mm_modal_${tier.key}`)
    .setTitle("Overused Community Request Form");

  const otherTrader = new TextInputBuilder()
    .setCustomId("other_trader")
    .setLabel("Other Trader (@user, user, or ID)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("Example: @SomeUser | SomeUser | 123456…");

  const tradeDetails = new TextInputBuilder()
    .setCustomId("trade_details")
    .setLabel("Trade Details")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const yourSide = new TextInputBuilder()
    .setCustomId("your_side")
    .setLabel("Your Side (Buyer or Seller)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("Buyer / Seller");

  const tip = new TextInputBuilder()
    .setCustomId("tip")
    .setLabel("MM Tip (20%)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("Example: 20m");

  modal.addComponents(
    new ActionRowBuilder().addComponents(otherTrader),
    new ActionRowBuilder().addComponents(tradeDetails),
    new ActionRowBuilder().addComponents(yourSide),
    new ActionRowBuilder().addComponents(tip),
  );

  return modal;
}

async function resolveUserIdFromInput(guild, input) {
  if (!input) return null;

  // mention <@123> or <@!123>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];

  // numeric id
  if (/^\d{15,20}$/.test(input)) return input;

  // try username search (best-effort)
  const lower = input.toLowerCase();
  const members = await guild.members.fetch({ limit: 100 }).catch(() => null);
  if (!members) return null;

  const found = members.find(m => m.user.username.toLowerCase() === lower);
  return found?.id || null;
}

// ---- Interactions: tier select -> modal ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "mm_tier_select") return;

  const tierKey = interaction.values?.[0];
  const settings = getSettingsOrNull(interaction.guildId);

  if (!mustBeSetup(settings)) {
    return interaction.reply({ content: "❌ Setup missing. Run `:mmsetup ...` first.", ephemeral: true }).catch(() => null);
  }

  const modal = buildTicketModal(tierKey);
  await interaction.showModal(modal).catch(() => null);
});

// ==============================
// TICKET MODALS + BUTTON HANDLERS (FIXED)
// ==============================

// ---- Modal submit: create ticket OR add user ----
client.on("interactionCreate", async (interaction) => {
if (!interaction.isModalSubmit()) return;

const guild = interaction.guild;
const settings = getSettingsOrNull(interaction.guildId);
if (!mustBeSetup(settings)) {
return interaction.reply({ content: "❌ Setup missing.", ephemeral: true });
}

// =====================
// ADD USER MODAL
// =====================
if (interaction.customId === "ticket_adduser_modal") {
const raw = interaction.fields.getTextInputValue("user_to_add").trim();

let targetId = null;

// mention
const mention = raw.match(/^<@!?(\d+)>$/);
if (mention) targetId = mention[1];

// numeric ID
if (!targetId && /^\d{15,20}$/.test(raw)) targetId = raw;

if (!targetId) {
return interaction.reply({
content: "❌ Invalid user. Mention or ID only.",
ephemeral: true,
});
}

await interaction.channel.permissionOverwrites.edit(targetId, {
ViewChannel: true,
SendMessages: true,
ReadMessageHistory: true,
});

return interaction.reply({
content: `✅ Added <@${targetId}> to this ticket.`,
ephemeral: true,
});
}

// =====================
// CREATE TICKET MODAL
// =====================
if (!interaction.customId.startsWith("mm_modal_")) return;

const tierKey = interaction.customId.replace("mm_modal_", "");
const ownerId = interaction.user.id;

const otherRaw = interaction.fields.getTextInputValue("other_trader").trim();
const details = interaction.fields.getTextInputValue("trade_details").trim();
const side = interaction.fields.getTextInputValue("your_side").trim();
const tip = interaction.fields.getTextInputValue("tip").trim();

const ownerMember = await guild.members.fetch(ownerId).catch(() => null);
if (!ownerMember) {
return interaction.reply({ content: "❌ Member fetch failed.", ephemeral: true });
}

const otherId = await resolveUserIdFromInput(guild, otherRaw);

const ticketChannel = await createTicketChannel(
guild,
settings,
ownerMember,
otherId,
tierKey
);

if (!ticketChannel) {
return interaction.reply({
content: "❌ Failed to create ticket.",
ephemeral: true,
});
}

const ticketData = {
ticket_channel_id: ticketChannel.id,
guild_id: guild.id,
owner_id: ownerId,
other_id: otherId,
tier_key: tierKey,
tip,
side,
details,
claimed_by: null,
created_at: Date.now(),
closed_at: null,
};

stmtInsertTicket.run(ticketData);

await ticketChannel.send({
content: `<@&${settings.mm_role_id}> — ticket created.`,
embeds: [ticketEmbed(ticketData, guild)],
components: [ticketButtonsRow(false)],
});

await interaction.reply({
content: `✅ Ticket created: <#${ticketChannel.id}>`,
ephemeral: true,
});
});

// ---- Ticket button handlers ----
client.on("interactionCreate", async (interaction) => {
if (!interaction.isButton()) return;

const ticket = stmtGetTicket.get(interaction.channelId);
if (!ticket) {
return interaction.reply({
content: "❌ This is not a ticket channel.",
ephemeral: true,
});
}

const settings = getSettingsOrNull(interaction.guildId);
if (!mustBeSetup(settings)) {
return interaction.reply({ content: "❌ Setup missing.", ephemeral: true });
}

const guild = interaction.guild;
const member = await guild.members.fetch(interaction.user.id).catch(() => null);
if (!member) return;

const isMM =
member.roles.cache.has(settings.mm_role_id) ||
member.permissions.has(PermissionsBitField.Flags.Administrator);

// =====================
// CLAIM TICKET (HARD LOCK)
// =====================
if (interaction.customId === "ticket_claim") {
if (!isMM) {
return interaction.reply({
content: "❌ Only middlemen can claim.",
ephemeral: true,
});
}

stmtUpdateTicketClaim.run(interaction.user.id, interaction.channelId);
const updated = stmtGetTicket.get(interaction.channelId);

await interaction.channel.permissionOverwrites.set([
{ id: guild.id, deny: ["ViewChannel", "SendMessages"] },
{ id: settings.mm_role_id, deny: ["ViewChannel", "SendMessages"] },

{
id: updated.owner_id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},

...(updated.other_id
? [{
id: updated.other_id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
}]
: []),

{
id: interaction.user.id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},

{
id: interaction.client.user.id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},
]);

await interaction.channel.send(`✅ <@${interaction.user.id}> claimed this ticket.`);
return interaction.update({
embeds: [ticketEmbed(updated, guild)],
components: [ticketButtonsRow(false)],
});
}

// =====================
// UNCLAIM TICKET
// =====================
if (interaction.customId === "ticket_unclaim") {
if (!isMM) {
return interaction.reply({
content: "❌ Only middlemen can unclaim.",
ephemeral: true,
});
}

stmtUpdateTicketClaim.run(null, interaction.channelId);
const updated = stmtGetTicket.get(interaction.channelId);

await interaction.channel.permissionOverwrites.set([
{ id: guild.id, deny: ["ViewChannel"] },
{
id: settings.mm_role_id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},
{
id: updated.owner_id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},
...(updated.other_id
? [{
id: updated.other_id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
}]
: []),
{
id: interaction.client.user.id,
allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
},
]);

await interaction.channel.send("🔓 Ticket unclaimed.");
return interaction.update({
embeds: [ticketEmbed(updated, guild)],
components: [ticketButtonsRow(false)],
});
}

// =====================
// ADD USER BUTTON
// =====================
if (interaction.customId === "ticket_adduser") {
if (!isMM) {
return interaction.reply({
content: "❌ Only middlemen can add users.",
ephemeral: true,
});
}

const modal = new ModalBuilder()
.setCustomId("ticket_adduser_modal")
.setTitle("Add User");

modal.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId("user_to_add")
.setLabel("User mention or ID")
.setStyle(TextInputStyle.Short)
.setRequired(true)
)
);

return interaction.showModal(modal);
}

// =====================
// CLOSE = DELETE
// =====================
if (interaction.customId === "ticket_close") {
if (!isMM) {
return interaction.reply({
content: "❌ Only middlemen can close.",
ephemeral: true,
});
}

stmtCloseTicket.run(Date.now(), interaction.channelId);

await interaction.reply({
content: "🗑️ Ticket closed. Deleting...",
ephemeral: true,
});

setTimeout(() => {
interaction.channel.delete().catch(() => null);
}, 3000);
}
});
// ---- PREFIX COMMANDS ----
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const settings = getSettingsOrNull(message.guild.id);
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || "").toLowerCase();

// :help
  if (cmd === "help") {
    return message.reply({
      embeds: [helpMainEmbed()],
      components: [helpSelectRow("help_menu")],
    }).catch(() => null);
  }

if (cmd === "say") {
  if (message.author.id !== OWNER_ID) return;

  const text = args.join(" ");
  if (!text) return message.channel.send("❌ Nothing to say.");

  await message.delete().catch(() => null);
  await message.channel.send(text);
  return; // 🚨 THIS LINE STOPS OTHER COMMAND LOGIC
}


  // :mmsetup <requestChannelId> <ticketCategoryId> <mmRoleId> <logChannelId> <clientRoleId> <membersRoleId>
  if (cmd === "mmsetup") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ Admin only.").catch(() => null);
    }
    const [requestChannelId, ticketCategoryId, mmRoleId, logChannelId, clientRoleId, membersRoleId] = args;

    if (!requestChannelId || !ticketCategoryId || !mmRoleId || !logChannelId || !clientRoleId || !membersRoleId) {
      return message.reply(
        `❌ Usage:\n\`${PREFIX}mmsetup <requestChannelId> <ticketCategoryId> <mmRoleId> <logChannelId> <clientRoleId> <membersRoleId>\``
      ).catch(() => null);
    }

    stmtUpsertSettings.run({
      guild_id: message.guild.id,
      request_channel_id: requestChannelId,
      ticket_category_id: ticketCategoryId,
      mm_role_id: mmRoleId,
      log_channel_id: logChannelId,
      protected_role_client_id: clientRoleId,
      protected_role_members_id: membersRoleId,
    });

    return message.reply("✅ Setup saved.").catch(() => null);
  }

  // :postmm (posts in the request channel)
  if (cmd === "postmm") {
    if (!settings || !mustBeSetup(settings)) {
      return message.reply("❌ Setup missing. Run `:mmsetup ...` first.").catch(() => null);
    }
    if (!mustHaveManageChannels(message.member)) {
      return message.reply("❌ Missing permission (Manage Channels).").catch(() => null);
    }

    const requestCh = await message.guild.channels.fetch(settings.request_channel_id).catch(() => null);
    if (!requestCh) return message.reply("❌ Request channel not found.").catch(() => null);

    await requestCh.send({
      embeds: [mmPanelEmbed()],
      components: [mmTierRow()],
    }).catch(() => null);

    await logToGuild(message.guild, settings, `📌 MM panel posted by <@${message.author.id}> in <#${requestCh.id}>`);
    return message.reply("✅ MM panel posted.").catch(() => null);
  }

  // ---- Manual ticket commands (for when buttons break) ----
  if (cmd === "claim" || cmd === "unclaim" || cmd === "adduser" || cmd === "close") {
    if (!settings || !mustBeSetup(settings)) return message.reply("❌ Setup missing.").catch(() => null);

    const ticket = stmtGetTicket.get(message.channel.id);
    if (!ticket) return message.reply("❌ This is not a ticket channel.").catch(() => null);

    const isMM = message.member.roles.cache.has(settings.mm_role_id) || message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isMM) return message.reply("❌ Only middlemen/staff can do that.").catch(() => null);

    if (cmd === "claim") {
      stmtUpdateTicketClaim.run(message.author.id, message.channel.id);
      const updated = stmtGetTicket.get(message.channel.id);
      await message.channel.send({ embeds: [ticketEmbed(updated, message.guild)], components: [ticketButtonsRow(false)] }).catch(() => null);
      await logToGuild(message.guild, settings, `🟢 Claimed (manual): <#${message.channel.id}> by <@${message.author.id}>`);
      return;
    }

    if (cmd === "unclaim") {
      stmtUpdateTicketClaim.run(null, message.channel.id);
      const updated = stmtGetTicket.get(message.channel.id);
      await message.channel.send({ embeds: [ticketEmbed(updated, message.guild)], components: [ticketButtonsRow(false)] }).catch(() => null);
      await logToGuild(message.guild, settings, `🔴 Unclaimed (manual): <#${message.channel.id}> by <@${message.author.id}>`);
      return;
    }

    if (cmd === "adduser") {
      const target = message.mentions.users.first();
      if (!target) return message.reply(`❌ Usage: \`${PREFIX}adduser @user\``).catch(() => null);

      await message.channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      }).catch(() => null);

      await logToGuild(message.guild, settings, `➕ Added user (manual) <@${target.id}> to <#${message.channel.id}> by <@${message.author.id}>`);
      return message.reply(`✅ Added <@${target.id}> to this ticket.`).catch(() => null);
    }

    if (cmd === "close") {
  await logToGuild(
    message.guild,
    settings,
    `🗑️ Closed & deleted: <#${message.channel.id}> by <@${message.author.id}>`
  ).catch(() => null);

  await message.reply("🗑️ Closing ticket in 2 seconds…").catch(() => null);

  setTimeout(() => {
    message.channel.delete("Ticket closed by command")
      .catch(() => null);
  }, 2000);

  return;
}
  }// ---- Utility: :search <coin> (Coingecko FULL) ----
if (cmd === "search") {
  const q = args.join(" ").trim();
  if (!q) {
    return message.reply(`❌ Usage: \`${PREFIX}search <coin>\``).catch(() => null);
  }

  // Search coin
  const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;
  const res = await fetch(searchUrl).catch(() => null);
  if (!res) return message.reply("❌ Crypto API error.").catch(() => null);

  const data = await res.json().catch(() => null);
  const coin = data?.coins?.[0];
  if (!coin) return message.reply("❌ No results found.").catch(() => null);

  // Get coin market data
  const coinUrl = `https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const res2 = await fetch(coinUrl).catch(() => null);
  if (!res2) return message.reply("❌ Failed to fetch coin data.").catch(() => null);

  const d = await res2.json().catch(() => null);
  const m = d?.market_data;

  const emb = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle(`📈 ${d.name} (${d.symbol.toUpperCase()})`)
    .addFields(
      { name: "💰 Price (USD)", value: `$${m?.current_price?.usd?.toLocaleString() || "N/A"}`, inline: true },
      { name: "📊 24h Change", value: `${m?.price_change_percentage_24h?.toFixed(2) || "N/A"}%`, inline: true },
      { name: "📈 High (24h)", value: `$${m?.high_24h?.usd?.toLocaleString() || "N/A"}`, inline: true },
      { name: "📉 Low (24h)", value: `$${m?.low_24h?.usd?.toLocaleString() || "N/A"}`, inline: true },
      { name: "🏦 Market Cap", value: `$${m?.market_cap?.usd?.toLocaleString() || "N/A"}`, inline: true },
      { name: "🔁 Volume (24h)", value: `$${m?.total_volume?.usd?.toLocaleString() || "N/A"}`, inline: true }
    )
    .setFooter({ text: "Data: CoinGecko" });

  return message.reply({ embeds: [emb] }).catch(() => null);
}
  // :pingtime
  if (cmd === "pingtime") {
    const sent = await message.reply("⏱ Checking…").catch(() => null);
    if (!sent) return;
    const ping = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit(`✅ Pong — ${ping}ms`).catch(() => null);
  }

  // :avatar [user]
  if (cmd === "avatar") {
    const target = message.mentions.users.first() || message.author;
    const url = target.displayAvatarURL({ size: 2048 });
    const emb = new EmbedBuilder().setTitle(`🖼 Avatar — ${target.username}`).setImage(url);
    return message.reply({ embeds: [emb] }).catch(() => null);
  }

  // ---- Staff: :demote @user (remove all roles except protected 2) ----
  if (cmd === "demote") {
    if (!settings || !mustBeSetup(settings)) return message.reply("❌ Setup missing.").catch(() => null);

    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply("❌ Only high admin can use this command.").catch(() => null);
    }

    const target = message.mentions.members.first();
    if (!target) return message.reply(`❌ Usage: \`${PREFIX}demote @user\``).catch(() => null);

    const protectedSet = new Set([settings.protected_role_client_id, settings.protected_role_members_id]);

    // roles to keep (only those 2)
    const keep = target.roles.cache
      .filter(r => protectedSet.has(r.id))
      .map(r => r.id);

    // ensure they exist
    const finalKeep = keep.filter(id => message.guild.roles.cache.has(id));

    await target.roles.set(finalKeep, "Demote (keep only protected roles)").catch(() => null);
    await logToGuild(message.guild, settings, `🔻 Demoted <@${target.id}> by <@${message.author.id}> (kept protected roles only)`);
    return message.reply(`✅ Demoted <@${target.id}> (kept protected roles only).`).catch(() => null);
  }

  // ---- Trip system: :trip 2h / :trip cancel / :triplist ----
  if (cmd === "trip") {
    if (!settings || !mustBeSetup(settings)) return message.reply("❌ Setup missing.").catch(() => null);
    const me = message.guild.members.me;
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply("❌ I need *Manage Roles* to run trips.").catch(() => null);
    }

    const sub = (args[0] || "").toLowerCase();

    // cancel
    if (sub === "cancel") {
      const trip = stmtGetTrip.get(message.guild.id, message.author.id);
      if (!trip) return message.reply("❌ You are not on a trip.").catch(() => null);

      const saved = JSON.parse(trip.saved_roles || "[]");
      await restoreTrip(message.guild, settings, message.member, saved).catch(() => null);
      stmtDeleteTrip.run(message.guild.id, message.author.id);

      const key = `${message.guild.id}:${message.author.id}`;
      if (tripTimers.has(key)) clearTimeout(tripTimers.get(key));
      tripTimers.delete(key);

      await logToGuild(message.guild, settings, `🧳 Trip canceled — restored roles for <@${message.author.id}>`);
      return message.reply("✅ Trip canceled. Roles restored.").catch(() => null);
    }

    // start trip
    const dur = parseDuration(sub);
    if (!dur) return message.reply(`❌ Usage: \`${PREFIX}trip 2h\` (or \`${PREFIX}trip cancel\`)`).catch(() => null);

    const endAt = Date.now() + dur;

    // Save current roles (excluding @everyone)
    const currentRoles = message.member.roles.cache
      .filter(r => r.id !== message.guild.roles.everyone.id)
      .map(r => r.id);

    const protectedSet = new Set([settings.protected_role_client_id, settings.protected_role_members_id]);

    const keep = currentRoles.filter(rid => protectedSet.has(rid));
    const removeAllExcept = keep.filter(id => message.guild.roles.cache.has(id));

    // set roles to only protected
    await message.member.roles.set(removeAllExcept, "Trip started (keep protected roles)").catch(() => null);

    // store trip
    stmtUpsertTrip.run(message.guild.id, message.author.id, endAt, JSON.stringify(currentRoles));
    scheduleTripEnd(message.guild.id, message.author.id, endAt);

    await logToGuild(message.guild, settings, `🧳 Trip started by <@${message.author.id}> for ${ms(dur, { long: true })}`);
    return message.reply(`✅ Trip started for **${ms(dur, { long: true })}**. Roles removed (protected roles kept).`).catch(() => null);
  }
  if (cmd === "triplist") {
    if (!settings || !mustBeSetup(settings)) return message.reply("❌ Setup missing.").catch(() => null);

    const rows = db.prepare(`SELECT * FROM trips WHERE guild_id=?`).all(message.guild.id);
    if (!rows.length) return message.reply("✅ Nobody is on trip.").catch(() => null);

    const list = rows
      .map(r => `• <@${r.user_id}> — ends <t:${Math.floor(r.end_at / 1000)}:R>`)
      .join("\n");

    const emb = new EmbedBuilder().setTitle("🧳 Trip List").setDescription(list);
    return message.reply({ embeds: [emb] }).catch(() => null);
  }

if (cmd === "unzap") {
  if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers))
    return message.reply("❌ Missing permission.");

  const target = message.mentions.users.first();
  if (!target) return message.reply("❌ Mention a user.");

  return message.channel.send(`🔄 ${target.tag} has returned to the server.`);
}

if (cmd === "unbye") {
  if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return message.reply("❌ You don't have permission to unban users.");
  }

  const arg = args[0];
  if (!arg) {
    return message.reply("❌ Provide a user ID to unban.");
  }

  // Works with ID or mention
  const userId = arg.replace(/[<@!>]/g, "");

  try {
    await message.guild.bans.remove(userId);

    const user = await client.users.fetch(userId).catch(() => null);

    return message.channel.send(
      `✅ ${user ? user.tag : `User ID ${userId}`} has been unbanned.`
    );
  } catch (err) {
    return message.reply("❌ That user is not banned or the ID is invalid.");
  }
}

   // ⚡ zap = quick kick
    if (cmd === "zap") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("❌ You don't have permission to use this.");
      }

      const target = message.mentions.members.first();
      if (!target) return message.reply("❌ Mention a user to kick.");

      if (!target.kickable) {
        return message.reply("❌ I can't kick that user.");
      }

      await target.kick(`Zapped by ${message.author.tag}`);
      await message.channel.send(`⚡ ${target.user.tag} got **ZAPPED**`);

      logToGuild(
        message.guild,
        getSettingsOrNull(message.guild.id),
        `⚡ **ZAP**: ${target.user.tag} kicked by ${message.author.tag}`
      );
    }
// 🔇 STFU = timeout
if (cmd === "stfu") {
if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
return message.reply("❌ You don't have permission to use this.");
}

const target =
message.mentions.members.first() ||
await message.guild.members.fetch(args[0]).catch(() => null);

const minutes = parseInt(args[1]) || 10;

if (!target) {
return message.reply("❌ Mention a user or provide a valid user ID.");
}

if (!target.moderatable) {
return message.reply("❌ I can't timeout that user (role hierarchy).");
}

await target.timeout(minutes * 60 * 1000, `STFU by ${message.author.tag}`);
await message.channel.send(
`🔇 **${target.user.tag}** has been timed out for **${minutes} minutes**.`
);

return; // 🚨 REQUIRED
}
    
// 🚫 BYE = ban
if (cmd === "bye") {
if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
return message.reply("❌ You don't have permission to use this.");
}

const target =
message.mentions.members.first() ||
await message.guild.members.fetch(args[0]).catch(() => null);

if (!target) {
return message.reply("❌ Mention a user or provide a valid user ID.");
}

if (!target.bannable) {
return message.reply("❌ I can't ban that user (role hierarchy).");
}

await target.ban({ reason: `Banned by ${message.author.tag}` });

await message.channel.send(
`🚫 **${target.user.tag}** that fuck nigger is GONE.`
);

return; // 🚨 REQUIRED
}
});

// ---- Login ----
client.login(TOKEN);
