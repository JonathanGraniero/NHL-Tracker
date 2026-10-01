import { getTeam } from "../data/teams";
import type { MessageBody } from "../discord/api";
import { espnPlus } from "./espn";
import { networkLabel } from "./networks";
import { formatDay, type Broadcast, type Game } from "../sources/nhl";
import type { Country } from "../types";

const COUNTRIES: readonly { code: Country; flag: string }[] = [
  { code: "US", flag: "🇺🇸" },
  { code: "CA", flag: "🇨🇦" },
];
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
  /** Only show this country's networks. Both countries when unset. */
  country?: Country;
}

/** One embed listing a day's games, with start times in each viewer's time zone. */
export function buildScheduleMessage({ date, games, nextDay, nextWeek, team, country }: ScheduleOptions): MessageBody {
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

  let description = games.map((g) => gameBlock(g, { country })).join("\n\n");
  // A full 16-game night with long network lists can overflow: drop team networks, then truncate.
  if (description.length > MAX_DESCRIPTION) {
    description = games.map((g) => gameBlock(g, { country, nationalOnly: true })).join("\n\n");
  }
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;

  const where = country === "US" ? "US " : country === "CA" ? "Canadian " : "";
  return {
    embeds: [
      {
        title,
        url,
        color,
        description,
        footer: { text: `Times are in your time zone · ${where}TV from NHL.com · (TEAM) = that team's local channel` },
      },
    ],
  };
}

/**
 * A game and where to watch it, one line per country:
 *
 *   <t:…:t> · **[PHI @ BOS](…)**
 *   🇺🇸 NHL Network · NBC Sports Philadelphia (PHI) · NESN (BOS)
 *   ↳ Also on ESPN+ outside the PHI and BOS areas
 *   🇨🇦 Sportsnet · TVA Sports (French) · RDS (MTL, French)
 */
export function gameBlock(game: Game, opts: { country?: Country; nationalOnly?: boolean } = {}): string {
  const matchup = `**[${game.away} @ ${game.home}](${game.url})**${game.gameType === 1 ? " (preseason)" : ""}`;
  const lines = [`${status(game)} · ${matchup}`];
  if (game.scheduleState === "OK") {
    for (const { code, flag } of COUNTRIES) {
      if (opts.country && opts.country !== code) continue;
      const networks = countryNetworks(game, code, opts.nationalOnly ?? false);
      if (networks.length > 0) lines.push(`${flag} ${networks.join(" · ")}`);
      if (code === "US") {
        const streaming = espnPlusNote(game);
        if (streaming) lines.push(networks.length > 0 ? `↳ Also on ${streaming}` : `${flag} ${streaming}`);
      }
    }
  }
  return lines.join("\n");
}

/** "ESPN+ outside the PHI and BOS areas", or nothing when it isn't (or might not be) on Power Play. */
function espnPlusNote(game: Game): string | undefined {
  if (game.state === "FINAL" || game.state === "OFF") return undefined;
  const status = espnPlus(game);
  if (status.kind !== "out-of-market") return undefined;
  const teams = status.blackedOut;
  if (teams.length === 0) return "ESPN+";
  return `ESPN+ outside the ${teams.join(" and ")} area${teams.length > 1 ? "s" : ""}`;
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

/** National networks first, then each team's own channel tagged with the team. */
function countryNetworks(game: Game, country: string, nationalOnly: boolean): string[] {
  const here = game.broadcasts.filter((b) => b.country === country);
  const national = unique(here.filter((b) => b.market === "N").map((b) => b.network));
  const out = national.map((n) => networkLabel(n));
  if (nationalOnly) return out;

  // Network → teams it carries this game for (Scripps can be both teams' channel).
  const local = new Map<string, string[]>();
  for (const b of here) {
    if (b.market === "N" || national.includes(b.network)) continue;
    const teams = local.get(b.network) ?? [];
    if (!teams.includes(teamFor(game, b))) teams.push(teamFor(game, b));
    local.set(b.network, teams);
  }
  for (const [network, teams] of local) out.push(networkLabel(network, teams));
  return out;
}

function teamFor(game: Game, b: Broadcast): string {
  return b.market === "H" ? game.home : game.away;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
