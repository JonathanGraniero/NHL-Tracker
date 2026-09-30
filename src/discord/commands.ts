import {
  EPHEMERAL,
  InteractionResponseType,
  MAX_CHOICES,
  OptionType,
  type Choice,
  type Interaction,
  type InteractionResponse,
} from "./types";
import { getTeam, resolveTeam, searchTeams } from "../data/teams";
import {
  ALL_TEAMS,
  clearChannel,
  listForChannel,
  removeSubscription,
  upsertSubscription,
} from "../db/subscriptions";
import { ALL_TYPES, describeTypes, type TransactionType } from "../types";
import type { Env } from "../env";

/** Permission bit for "Manage Server". Admins can change who may use a command in Server Settings → Integrations. */
const MANAGE_GUILD = String(1 << 5);
/** Commands only work inside servers (not DMs), since subscriptions belong to a channel. */
const GUILD_ONLY = [0];
/** Autocomplete value meaning "remove every subscription in this channel". */
const CLEAR_ALL = "__clear__";

/** Slash command definitions, uploaded to Discord by scripts/register-commands.ts. */
export const COMMANDS = [
  {
    name: "ping",
    description: "Check that the NHL Trade Tracker is online.",
  },
  {
    name: "subscribe",
    description: "Post a team's confirmed trades, waivers and signings in this channel.",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
    options: [
      { type: OptionType.STRING, name: "team", description: "Team to follow, or \"All teams\"", required: true, autocomplete: true },
      { type: OptionType.BOOLEAN, name: "trades", description: "Post trades (default: yes)" },
      { type: OptionType.BOOLEAN, name: "waivers", description: "Post waiver moves (default: yes)" },
      { type: OptionType.BOOLEAN, name: "signings", description: "Post signings and extensions (default: yes)" },
    ],
  },
  {
    name: "unsubscribe",
    description: "Stop posting a team's news in this channel.",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
    options: [
      { type: OptionType.STRING, name: "team", description: "Team to stop following", required: true, autocomplete: true },
    ],
  },
  {
    name: "subscriptions",
    description: "Show which teams this channel follows.",
    contexts: GUILD_ONLY,
  },
] as const;

export async function handleCommand(interaction: Interaction, env: Env): Promise<InteractionResponse> {
  const name = interaction.data?.name;
  if (name === "ping") return reply("🏒 Pong! NHL Trade Tracker is online.");

  const { guild_id: guildId, channel_id: channelId } = interaction;
  if (!guildId || !channelId) return reply("This command only works in a server channel.");

  switch (name) {
    case "subscribe":
      return subscribe(env.DB, guildId, channelId, interaction);
    case "unsubscribe":
      return unsubscribe(env.DB, channelId, interaction);
    case "subscriptions":
      return showSubscriptions(env.DB, channelId);
    default:
      return reply("Unknown command.");
  }
}

export async function handleAutocomplete(interaction: Interaction, env: Env): Promise<InteractionResponse> {
  const focused = interaction.data?.options?.find((o) => o.focused);
  const query = String(focused?.value ?? "");
  let choices: Choice[] = [];

  if (interaction.data?.name === "subscribe") {
    choices = teamChoices(query);
  } else if (interaction.data?.name === "unsubscribe" && interaction.channel_id) {
    choices = await subscribedChoices(env.DB, interaction.channel_id, query);
  }

  return {
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: choices.slice(0, MAX_CHOICES) },
  };
}

async function subscribe(db: D1Database, guildId: string, channelId: string, interaction: Interaction) {
  const teamInput = stringOption(interaction, "team");
  const teamCode = parseTeam(teamInput);
  if (!teamCode) return reply(`❌ I couldn't find a team called "${teamInput}". Pick one from the list.`);

  const optionFor: Record<TransactionType, string> = { trade: "trades", waiver: "waivers", signing: "signings" };
  const types = ALL_TYPES.filter((t) => booleanOption(interaction, optionFor[t]) ?? true);
  if (types.length === 0) return reply("❌ Pick at least one of trades, waivers or signings.");

  const result = await upsertSubscription(db, { guildId, channelId, teamCode, types });
  const verb = result === "created" ? "will now get" : "now gets";
  return reply(`✅ This channel ${verb} **${describeTypes(types)}** for **${teamLabel(teamCode)}**.`);
}

async function unsubscribe(db: D1Database, channelId: string, interaction: Interaction) {
  const teamInput = stringOption(interaction, "team");

  if (teamInput === CLEAR_ALL) {
    const removed = await clearChannel(db, channelId);
    return reply(
      removed > 0
        ? `✅ Removed all ${removed} subscription${removed === 1 ? "" : "s"} from this channel.`
        : "This channel isn't following any teams.",
    );
  }

  const teamCode = parseTeam(teamInput);
  if (!teamCode) return reply(`❌ I couldn't find a team called "${teamInput}".`);

  const removed = await removeSubscription(db, channelId, teamCode);
  return reply(
    removed
      ? `✅ This channel will no longer get news for **${teamLabel(teamCode)}**.`
      : `This channel wasn't following **${teamLabel(teamCode)}**.`,
  );
}

async function showSubscriptions(db: D1Database, channelId: string) {
  const subs = await listForChannel(db, channelId);
  if (subs.length === 0) {
    return reply("This channel isn't following any teams yet. Use `/subscribe` to add one.");
  }
  // "All teams" first, then alphabetical by team name.
  subs.sort((a, b) =>
    a.teamCode === ALL_TEAMS ? -1 : b.teamCode === ALL_TEAMS ? 1 : teamLabel(a.teamCode).localeCompare(teamLabel(b.teamCode)),
  );
  const lines = subs.map((s) => `• **${teamLabel(s.teamCode)}**: ${describeTypes(s.types)}`);
  return reply(`**This channel follows:**\n${lines.join("\n")}`);
}

function teamChoices(query: string): Choice[] {
  const q = query.trim().toLowerCase();
  const allTeams: Choice[] = !q || "all teams".startsWith(q) || q === "*" ? [{ name: "⭐ All teams", value: ALL_TEAMS }] : [];
  return [...allTeams, ...searchTeams(query).map((t) => ({ name: t.name, value: t.code }))];
}

async function subscribedChoices(db: D1Database, channelId: string, query: string): Promise<Choice[]> {
  const subs = await listForChannel(db, channelId);
  const q = query.trim().toLowerCase();
  const matches = subs
    .map((s) => ({ name: teamLabel(s.teamCode), value: s.teamCode }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q));
  if (subs.length > 1 && (!q || "remove all".includes(q))) {
    matches.push({ name: "🗑️ Remove all from this channel", value: CLEAR_ALL });
  }
  return matches;
}

/** A team code, ALL_TEAMS, or undefined. Handles autocomplete values and hand-typed text. */
function parseTeam(input: string): string | undefined {
  if (input === ALL_TEAMS || /^all( teams)?$/i.test(input)) return ALL_TEAMS;
  return resolveTeam(input)?.code;
}

function teamLabel(code: string): string {
  return code === ALL_TEAMS ? "All teams" : (getTeam(code)?.name ?? code);
}

function stringOption(interaction: Interaction, name: string): string {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "string" ? value.trim() : "";
}

function booleanOption(interaction: Interaction, name: string): boolean | undefined {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "boolean" ? value : undefined;
}

function reply(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}
