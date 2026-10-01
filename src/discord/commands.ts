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
import { ALL_TYPES, describeTypes, type PostType, type TransactionType } from "../types";
import { editOriginalResponse, type MessageBody } from "./api";
import { buildScheduleMessage } from "../games/format";
import { NhlError, easternDate, fetchDay, formatDay } from "../sources/nhl";
import { processItem, type Outcome } from "../news/pipeline";
import { RedditError, fetchPost, postIdFromInput } from "../sources/reddit";
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
    description: "Post a team's confirmed trades, waivers and signings, and optionally its daily games, here.",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
    options: [
      { type: OptionType.STRING, name: "team", description: "Team to follow, or \"All teams\"", required: true, autocomplete: true },
      { type: OptionType.BOOLEAN, name: "trades", description: "Post trades (default: yes)" },
      { type: OptionType.BOOLEAN, name: "waivers", description: "Post waiver moves (default: yes)" },
      { type: OptionType.BOOLEAN, name: "signings", description: "Post signings and extensions (default: yes)" },
      { type: OptionType.BOOLEAN, name: "games", description: "Post the day's games and where to watch them each morning (default: no)" },
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
  {
    name: "replay",
    description: "Run an r/hockey post through the filter and, if it's a confirmed move, post it in this server.",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
    options: [
      { type: OptionType.STRING, name: "post", description: "Link to the r/hockey post", required: true },
    ],
  },
  {
    name: "games",
    description: "Show a day's NHL games and where they're on TV.",
    options: [
      { type: OptionType.STRING, name: "day", description: "Today (default), tomorrow or a date", autocomplete: true },
      { type: OptionType.STRING, name: "team", description: "Only this team's game", autocomplete: true },
      {
        type: OptionType.STRING,
        name: "country",
        description: "Only show TV channels in this country (default: both)",
        choices: [
          { name: "🇺🇸 United States", value: "US" },
          { name: "🇨🇦 Canada", value: "CA" },
        ],
      },
    ],
  },
] as const;

export async function handleCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<InteractionResponse> {
  const name = interaction.data?.name;
  if (name === "ping") return reply("🏒 Pong! NHL Trade Tracker is online.");
  if (name === "games") return games(ctx, interaction);

  const { guild_id: guildId, channel_id: channelId } = interaction;
  if (!guildId || !channelId) return reply("This command only works in a server channel.");

  switch (name) {
    case "subscribe":
      return subscribe(env.DB, guildId, channelId, interaction);
    case "unsubscribe":
      return unsubscribe(env.DB, channelId, interaction);
    case "subscriptions":
      return showSubscriptions(env.DB, channelId);
    case "replay":
      return replay(env, ctx, guildId, interaction);
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
  } else if (interaction.data?.name === "games") {
    choices =
      focused?.name === "day"
        ? dayChoices(query, Date.now())
        : searchTeams(query).map((t) => ({ name: t.name, value: t.code }));
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
  const types: PostType[] = ALL_TYPES.filter((t) => booleanOption(interaction, optionFor[t]) ?? true);
  // The daily schedule is opt-in: a morning post every game day is noisier than news.
  if (booleanOption(interaction, "games") === true) types.push("games");
  if (types.length === 0) return reply("❌ Pick at least one of trades, waivers, signings or games.");

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

/** Answers straight away ("thinking…"), then fetches and posts in the background. */
function replay(env: Env, ctx: ExecutionContext, guildId: string, interaction: Interaction): InteractionResponse {
  const input = stringOption(interaction, "post");
  const postId = postIdFromInput(input);
  if (!postId) return reply(`❌ That doesn't look like a Reddit post link: "${input}"`);

  ctx.waitUntil(
    (async () => {
      let content: string;
      try {
        const item = await fetchPost(postId);
        content = item
          ? describeReplay(await processItem(env, item, { now: Date.now(), guildId }), item.title)
          : "❌ Reddit doesn't have a post with that link.";
      } catch (err) {
        console.error("replay failed", err);
        content =
          err instanceof RedditError && err.status === 429
            ? "⏳ Reddit is rate-limiting the bot right now. Try again in a minute."
            : "❌ Something went wrong fetching that post. Try again in a minute.";
      }
      await editOriginalResponse(interaction.application_id, interaction.token, { content });
    })(),
  );
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL },
  };
}

function describeReplay(outcome: Outcome, title: string): string {
  const quoted = `> ${title}`;
  if (outcome.kind === "rejected") return `⏭️ **Wouldn't post this:** ${outcome.reason}.\n${quoted}`;
  if (outcome.kind === "duplicate") return `✅ Already recorded as a confirmed move.\n${quoted}`;

  const { event, channels, failed } = outcome;
  const teams = event.teams.map(teamLabel).join(event.type === "trade" ? " ↔ " : ", ");
  const lines = [`✅ **Confirmed ${event.type}** (${teams}) from **${event.source}**.`];
  if (channels.length > 0) lines.push(`Posted in ${channels.map((c) => `<#${c}>`).join(", ")}.`);
  if (failed.length > 0) {
    lines.push(`⚠️ Couldn't post in ${failed.map((c) => `<#${c}>`).join(", ")}. Check the bot can view the channel, send messages and embed links there.`);
  }
  if (channels.length === 0 && failed.length === 0) {
    lines.push(`Nothing new to post: no channel in this server follows these teams for ${event.type}s, or they already have it.`);
  }
  return `${lines.join("\n")}\n${quoted}`;
}

/** Answers straight away (publicly: everyone wants to know what's on), then fills in the schedule. */
function games(ctx: ExecutionContext, interaction: Interaction): InteractionResponse {
  const dayInput = stringOption(interaction, "day");
  const date = parseDay(dayInput, Date.now());
  if (!date) return reply(`❌ I don't understand the day "${dayInput}". Try today, tomorrow or a date like 2026-10-10.`);

  const teamInput = stringOption(interaction, "team");
  const team = teamInput ? resolveTeam(teamInput)?.code : undefined;
  if (teamInput && !team) return reply(`❌ I couldn't find a team called "${teamInput}". Pick one from the list.`);

  const countryInput = stringOption(interaction, "country").toUpperCase();
  const country = countryInput === "US" || countryInput === "CA" ? countryInput : undefined;

  ctx.waitUntil(
    (async () => {
      let body: MessageBody;
      try {
        const day = await fetchDay(date);
        const mine = team ? day.games.filter((g) => g.away === team || g.home === team) : day.games;
        // "Next games" only makes sense league-wide; a team filter would need more lookups.
        const next = mine.length === 0 && !team ? { nextDay: day.nextDay, nextWeek: day.nextWeek } : {};
        body = buildScheduleMessage({ date, games: mine, team, country, ...next });
      } catch (err) {
        console.error("games failed", err);
        body = {
          content:
            err instanceof NhlError
              ? "⏳ I couldn't reach NHL.com just now. Try again in a minute."
              : "❌ Something went wrong getting the schedule.",
        };
      }
      await editOriginalResponse(interaction.application_id, interaction.token, body);
    })(),
  );
  return { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}

/** "today", "tomorrow", "yesterday" or YYYY-MM-DD → an Eastern date. */
export function parseDay(input: string, now: number): string | undefined {
  const s = input.trim().toLowerCase();
  if (!s || s === "today") return easternDate(now);
  if (s === "tomorrow") return easternDate(now, 1);
  if (s === "yesterday") return easternDate(now, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`))) return s;
  return undefined;
}

/** Today, tomorrow and the rest of the week, labelled ("Today · Saturday, Oct 10"). */
function dayChoices(query: string, now: number): Choice[] {
  const q = query.trim().toLowerCase();
  const choices = [...Array(8).keys()].map((i): Choice => {
    const date = easternDate(now, i);
    const label = i === 0 ? `Today · ${formatDay(date)}` : i === 1 ? `Tomorrow · ${formatDay(date)}` : formatDay(date);
    return { name: label, value: date };
  });
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) return [{ name: formatDay(q), value: q }];
  return choices.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q));
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
