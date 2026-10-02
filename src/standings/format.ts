// /standings tables. Columns are fixed-width text inside a code block so they
// line up on phones too; ranks and order come straight from NHL.com, which
// has already applied the tiebreakers.
import type { Embed, MessageBody } from "../discord/api";
import { divisionsOf, type Conference, type Division, type Standings, type TeamStanding } from "../sources/nhl-standings";

export type StandingsView =
  | { kind: "league" }
  | { kind: "conference"; conference: Conference }
  | { kind: "division"; division: Division }
  | { kind: "playoffs"; conferences: Conference[] };

/** Column positions match row(). */
const header = (clinchColumn: boolean) => ` #  ${"Team".padEnd(clinchColumn ? 7 : 5)} GP  W-L-OT   PTS     P%`;
const CLINCH_LEGEND = "x clinched · y division · z conference · p Presidents' Trophy · e eliminated";

export function standingsMessage(standings: Standings, view: StandingsView): MessageBody {
  const embeds =
    view.kind === "playoffs"
      ? view.conferences.map((c) => playoffEmbed(standings, c))
      : [tableEmbed(standings, view)];
  return { embeds: embeds.map((e) => withFooter(e, standings)) };
}

function tableEmbed(standings: Standings, view: Exclude<StandingsView, { kind: "playoffs" }>): Embed {
  const { title, teams, rank } =
    view.kind === "league"
      ? { title: "🏒 NHL standings", teams: standings.teams, rank: (t: TeamStanding) => t.leagueRank }
      : view.kind === "conference"
        ? {
            title: `🏒 ${view.conference} Conference standings`,
            teams: standings.teams.filter((t) => t.conference === view.conference),
            rank: (t: TeamStanding) => t.conferenceRank,
          }
        : {
            title: `🏒 ${view.division} Division standings`,
            teams: standings.teams.filter((t) => t.division === view.division),
            rank: (t: TeamStanding) => t.divisionRank,
          };
  const sorted = [...teams].sort((a, b) => rank(a) - rank(b));
  const clinch = hasClinches(standings);
  return { title, description: codeBlock([header(clinch), ...sorted.map((t) => row(rank(t), t, clinch))]) };
}

/**
 * "If the season ended today": each division's top three, the two wild
 * cards, a cut line, then everyone else with how far back of the last
 * wild card they are, and the first-round matchups that would follow.
 */
function playoffEmbed(standings: Standings, conference: Conference): Embed {
  const teams = standings.teams.filter((t) => t.conference === conference);
  const clinch = hasClinches(standings);
  const lines: string[] = [header(clinch)];
  for (const division of divisionsOf(conference)) {
    lines.push(division.toUpperCase());
    teams
      .filter((t) => t.division === division && t.wildcardRank === 0)
      .sort((a, b) => a.divisionRank - b.divisionRank)
      .forEach((t) => lines.push(row(t.divisionRank, t, clinch)));
  }
  const wildcards = teams.filter((t) => t.wildcardRank > 0).sort((a, b) => a.wildcardRank - b.wildcardRank);
  lines.push("WILD CARD");
  wildcards.slice(0, 2).forEach((t) => lines.push(row(t.wildcardRank, t, clinch)));
  const lastIn = wildcards[1];
  if (wildcards.length > 2) {
    lines.push("─".repeat(header(clinch).length));
    for (const t of wildcards.slice(2)) {
      const back = lastIn ? lastIn.points - t.points : 0;
      lines.push(`${row(t.wildcardRank, t, clinch)}${back > 0 ? `  -${back}` : ""}`);
    }
  }

  const matchups = firstRound(teams, conference);
  const description = [
    codeBlock(lines),
    matchups.length > 0 ? `**First round if the season ended today**\n${matchups.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { title: `🏆 ${conference} Conference playoff picture`, description };
}

/**
 * The division winner with more points plays the second wild card, the
 * other plays the first; each division's 2nd plays its 3rd.
 */
export function firstRound(teams: readonly TeamStanding[], conference: Conference): string[] {
  const [a, b] = divisionsOf(conference);
  const seed = (division: Division, rank: number) =>
    teams.find((t) => t.division === division && t.wildcardRank === 0 && t.divisionRank === rank);
  const wildcard = (rank: number) => teams.find((t) => t.wildcardRank === rank);
  const winnerA = seed(a!, 1);
  const winnerB = seed(b!, 1);
  const [wc1, wc2] = [wildcard(1), wildcard(2)];
  if (!winnerA || !winnerB || !wc1 || !wc2) return [];
  const [better, other] = winnerA.conferenceRank < winnerB.conferenceRank ? [winnerA, winnerB] : [winnerB, winnerA];
  const pairs: [TeamStanding | undefined, TeamStanding | undefined][] = [
    [better, wc2],
    [other, wc1],
    [seed(a!, 2), seed(a!, 3)],
    [seed(b!, 2), seed(b!, 3)],
  ];
  return pairs.flatMap(([x, y]) => (x && y ? [`${x.team} vs ${y.team}`] : []));
}

/**
 * " 1  p-COL    82  55-16-11 121   .738". The clinch prefix column only
 * exists once some team has one (late season).
 */
function row(rank: number, t: TeamStanding, clinchColumn: boolean): string {
  const team = clinchColumn ? `${t.clinch ? `${t.clinch}-` : "  "}${t.team}`.padEnd(7) : t.team.padEnd(5);
  const record = `${t.wins}-${t.losses}-${t.otLosses}`;
  const pct = t.gamesPlayed > 0 ? t.pointPct.toFixed(3).replace(/^0/, "") : "---";
  return `${String(rank).padStart(2)}  ${team} ${String(t.gamesPlayed).padStart(2)}  ${record.padEnd(8)} ${String(t.points).padStart(3)}  ${pct.padStart(5)}`;
}

function hasClinches(standings: Standings): boolean {
  return standings.teams.some((t) => t.clinch);
}

function codeBlock(lines: readonly string[]): string {
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function withFooter(embed: Embed, standings: Standings): Embed {
  const clinched = standings.teams.some((t) => t.clinch);
  return {
    ...embed,
    url: "https://www.nhl.com/standings",
    footer: { text: clinched ? `${CLINCH_LEGEND} · NHL.com` : "Ranked by points with NHL tiebreakers · NHL.com" },
    timestamp: standings.updatedAt ? new Date(standings.updatedAt).toISOString() : undefined,
  };
}
