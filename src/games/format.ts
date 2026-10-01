import { getTeam } from "../data/teams";
import type { MessageBody } from "../discord/api";
import { formatDay, type Broadcast, type Game } from "../sources/nhl";

const FLAGS: Record<string, string> = { US: "🇺🇸", CA: "🇨🇦" };
const COUNTRY_ORDER = ["US", "CA"];
/** Regional networks are the noisy part of the listing; show this many per game. */
const MAX_LOCAL = 3;
/** Discord's embed description limit is 4096; leave room for the empty-slate note. */
const MAX_DESCRIPTION = 4000;
const NEUTRAL_COLOR = 0x2b2d31;

export interface ScheduleOptions {
  date: string;
  games: Game[];
  /** For an empty day: the next date with games, or failing that the next week with games. */
  nextDay?: string;
  nextWeek?: string;
  /** Team the list was narrowed to (/games team:…), for the title and colour. */
  team?: string;
}

/** One embed listing a day's games, with start times in each viewer's time zone. */
export function buildScheduleMessage({ date, games, nextDay, nextWeek, team }: ScheduleOptions): MessageBody {
  const teamName = team ? (getTeam(team)?.name ?? team) : undefined;
  const title = `🏒 ${teamName ?? "NHL games"} · ${formatDay(date)}`;
  const url = `https://www.nhl.com/schedule/${date}`;
  const color = team ? (getTeam(team)?.color ?? NEUTRAL_COLOR) : NEUTRAL_COLOR;

  if (games.length === 0) {
    const next = nextDay
      ? ` Next games: **${formatDay(nextDay)}**.`
      : nextWeek
        ? ` Next games: the week of **${formatDay(nextWeek)}**.`
        : "";
    return { embeds: [{ title, url, color, description: `No games${teamName ? ` for the ${teamName}` : ""}.${next}` }] };
  }

  let description = games.map((g) => gameLine(g, MAX_LOCAL)).join("\n");
  // A full 16-game night with long network lists can overflow: drop local networks, then truncate.
  if (description.length > MAX_DESCRIPTION) description = games.map((g) => gameLine(g, 0)).join("\n");
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;

  return {
    embeds: [
      {
        title,
        url,
        color,
        description,
        footer: { text: "Times are in your time zone · broadcasts from NHL.com" },
      },
    ],
  };
}

/** "<t:…:t> **[PHI @ BOS](…)** · 🇺🇸 NHLN · 🇨🇦 SN, TVAS · local: NESN, NBCSP" */
export function gameLine(game: Game, maxLocal = MAX_LOCAL): string {
  const matchup = `**[${game.away} @ ${game.home}](${game.url})**`;
  const parts = [`${status(game)} ${matchup}${game.gameType === 1 ? " (preseason)" : ""}`];
  if (game.scheduleState === "OK") parts.push(...broadcastParts(game.broadcasts, maxLocal));
  return parts.join(" · ");
}

function status(game: Game): string {
  if (game.scheduleState === "PPD") return "Postponed";
  if (game.scheduleState === "CNCL") return "Cancelled";
  if (game.scheduleState === "SUSP") return "Suspended";
  const score = game.awayScore !== undefined && game.homeScore !== undefined ? ` ${game.awayScore}–${game.homeScore}` : "";
  if (game.state === "FINAL" || game.state === "OFF") return `Final${score}`;
  if (game.state === "LIVE" || game.state === "CRIT") return `🔴 Live${score}`;
  return `<t:${Math.floor(game.startTime / 1000)}:t>`;
}

/** National networks grouped by country, then a capped list of the teams' own networks. */
function broadcastParts(broadcasts: readonly Broadcast[], maxLocal: number): string[] {
  const parts: string[] = [];
  const national = new Set<string>();
  const countries = [...new Set(broadcasts.map((b) => b.country))].sort(
    (a, b) => rank(COUNTRY_ORDER, a) - rank(COUNTRY_ORDER, b),
  );
  for (const country of countries) {
    const networks = unique(broadcasts.filter((b) => b.country === country && b.market === "N").map((b) => b.network));
    networks.forEach((n) => national.add(n));
    if (networks.length > 0) parts.push(`${FLAGS[country] ?? country} ${networks.join(", ")}`);
  }
  if (maxLocal > 0) {
    const local = unique(broadcasts.filter((b) => b.market !== "N").map((b) => b.network)).filter((n) => !national.has(n));
    if (local.length > 0) {
      const extra = local.length > maxLocal ? ` +${local.length - maxLocal}` : "";
      parts.push(`local: ${local.slice(0, maxLocal).join(", ")}${extra}`);
    }
  }
  return parts;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function rank(order: readonly string[], value: string): number {
  const i = order.indexOf(value);
  return i === -1 ? order.length : i;
}
