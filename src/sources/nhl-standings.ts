// NHL.com standings. One request covers all 32 teams, with division,
// conference and league ranks, wild-card positions and clinch markers already
// worked out (tiebreakers applied), so the bot displays NHL.com's order.
import { NhlError } from "./nhl";

const API = "https://api-web.nhle.com/v1";

export type Conference = "Eastern" | "Western";
export type Division = "Atlantic" | "Metropolitan" | "Central" | "Pacific";
/** x clinched a playoff spot, y the division, z the conference, p the Presidents' Trophy; e eliminated. */
export type Clinch = "x" | "y" | "z" | "p" | "e";

export interface TeamStanding {
  team: string;
  conference: Conference;
  division: Division;
  gamesPlayed: number;
  wins: number;
  losses: number;
  otLosses: number;
  points: number;
  /** 0–1. */
  pointPct: number;
  goalDifferential: number;
  /** NHL.com's ranks, tiebreakers applied. */
  leagueRank: number;
  conferenceRank: number;
  divisionRank: number;
  /** 0 = top three in the division; 1–2 = wild card; 3+ = outside a playoff spot. */
  wildcardRank: number;
  clinch?: Clinch;
}

export interface Standings {
  teams: TeamStanding[];
  /** When NHL.com last updated them, unix ms. */
  updatedAt?: number;
}

/** The parts of /v1/standings/now the bot reads. */
export interface NhlStandingsResponse {
  standingsDateTimeUtc?: string | null;
  standings?: NhlStandingsEntry[];
}

export interface NhlStandingsEntry {
  date?: string;
  teamAbbrev: { default: string };
  conferenceName: string;
  divisionName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  otLosses: number;
  points: number;
  pointPctg: number;
  goalDifferential: number;
  leagueSequence: number;
  conferenceSequence: number;
  divisionSequence: number;
  wildcardSequence: number;
  clinchIndicator?: string | null;
}

const CONFERENCES: readonly string[] = ["Eastern", "Western"] satisfies Conference[];
const DIVISIONS: readonly string[] = ["Atlantic", "Metropolitan", "Central", "Pacific"] satisfies Division[];
const CLINCHES: readonly string[] = ["x", "y", "z", "p", "e"] satisfies Clinch[];

export const isConference = (v: string): v is Conference => CONFERENCES.includes(v);
export const isDivision = (v: string): v is Division => DIVISIONS.includes(v);
const isClinch = (v: string): v is Clinch => CLINCHES.includes(v);

export async function fetchStandings(): Promise<Standings> {
  const res = await fetch(`${API}/standings/now`, {
    headers: { "User-Agent": "nhl-tracker (+https://github.com/JonathanGraniero/NHL-Tracker)" },
  });
  if (!res.ok) throw new NhlError(res.status);
  return parseStandings(await res.json<NhlStandingsResponse>());
}

export function parseStandings(raw: NhlStandingsResponse): Standings {
  const teams = (raw.standings ?? []).flatMap((s): TeamStanding[] => {
    const { conferenceName: conference, divisionName: division, clinchIndicator } = s;
    if (!isConference(conference) || !isDivision(division)) return [];
    const clinch = clinchIndicator && isClinch(clinchIndicator) ? clinchIndicator : undefined;
    return [
      {
        team: s.teamAbbrev.default,
        conference,
        division,
        gamesPlayed: s.gamesPlayed,
        wins: s.wins,
        losses: s.losses,
        otLosses: s.otLosses,
        points: s.points,
        pointPct: s.pointPctg,
        goalDifferential: s.goalDifferential,
        leagueRank: s.leagueSequence,
        conferenceRank: s.conferenceSequence,
        divisionRank: s.divisionSequence,
        wildcardRank: s.wildcardSequence,
        clinch,
      },
    ];
  });
  const updated = raw.standingsDateTimeUtc ? Date.parse(raw.standingsDateTimeUtc) : NaN;
  return { teams, updatedAt: Number.isNaN(updated) ? undefined : updated };
}

export function divisionsOf(conference: Conference): Division[] {
  return conference === "Eastern" ? ["Atlantic", "Metropolitan"] : ["Central", "Pacific"];
}
