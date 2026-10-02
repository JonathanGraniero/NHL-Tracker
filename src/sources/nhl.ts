// NHL.com's public web API (no key). /v1/schedule/{date} returns the week
// starting at {date}, grouped by *Eastern* date: a 7 pm Pacific game on
// Oct 10 starts at 02:00Z on Oct 11 but is listed under Oct 10.

export type Market = "N" | "H" | "A";

const MARKETS: readonly string[] = ["N", "H", "A"] satisfies Market[];

function isMarket(value: string): value is Market {
  return MARKETS.includes(value);
}

export interface Broadcast {
  /** "US" or "CA". */
  country: string;
  /** National, home team's or away team's broadcast. */
  market: Market;
  network: string;
}

export interface Game {
  id: number;
  /** Eastern date the NHL lists the game under, YYYY-MM-DD. */
  day: string;
  /** Unix ms. */
  startTime: number;
  away: string;
  home: string;
  venue: string;
  /** FUT, PRE, LIVE, CRIT, FINAL, OFF. */
  state: string;
  /** OK, PPD (postponed), SUSP or CNCL. */
  scheduleState: string;
  /** 1 preseason, 2 regular season, 3 playoffs. */
  gameType: number;
  awayScore?: number;
  homeScore?: number;
  broadcasts: Broadcast[];
  /** Game Center page on nhl.com. */
  url: string;
}

export interface ScheduleWeek {
  days: { date: string; games: Game[] }[];
  /** Start of the next week that has games (in the off-season, months away). */
  nextStartDate?: string;
}

export class NhlError extends Error {
  constructor(readonly status: number) {
    super(`NHL API responded ${status}`);
  }
}

const API = "https://api-web.nhle.com/v1";

/** The week of games starting on `date` (YYYY-MM-DD, Eastern). */
export async function fetchWeek(date: string): Promise<ScheduleWeek> {
  const res = await fetch(`${API}/schedule/${date}`, {
    headers: { "User-Agent": "nhl-tracker (+https://github.com/JonathanGraniero/NHL-Tracker)" },
  });
  if (!res.ok) throw new NhlError(res.status);
  return parseWeek(await res.json<NhlScheduleResponse>());
}

export interface Day {
  games: Game[];
  /** Next date this week with games ("no games today, next up Thursday"). */
  nextDay?: string;
  /** When nothing else this week has games: the next week that does. */
  nextWeek?: string;
}

/** Games on one Eastern date, and where the schedule picks up next. */
export async function fetchDay(date: string): Promise<Day> {
  const week = await fetchWeek(date);
  const games = week.days.find((d) => d.date === date)?.games ?? [];
  const nextDay = week.days.find((d) => d.date > date && d.games.length > 0)?.date;
  const nextWeek = !nextDay && week.nextStartDate && week.nextStartDate > date ? week.nextStartDate : undefined;
  return { games, nextDay, nextWeek };
}

/** The parts of NHL.com's /v1/schedule/{date} response the bot reads. */
export interface NhlScheduleResponse {
  /** Start of the next week that has games. */
  nextStartDate?: string;
  gameWeek?: NhlScheduleDay[];
}

export interface NhlScheduleDay {
  /** Eastern date, YYYY-MM-DD. */
  date: string;
  games?: NhlGame[];
}

export interface NhlGame {
  id: number;
  gameType: number;
  gameState: string;
  gameScheduleState: string;
  startTimeUTC: string;
  venue?: { default?: string };
  awayTeam: NhlGameTeam;
  homeTeam: NhlGameTeam;
  tvBroadcasts?: NhlBroadcast[];
  /** Path on nhl.com, e.g. "/gamecenter/pit-vs-wsh/2026/10/07/2026020053". */
  gameCenterLink?: string;
}

export interface NhlGameTeam {
  abbrev: string;
  /** Present once the game has started. */
  score?: number;
}

export interface NhlBroadcast {
  /** "N" national, "H" home, "A" away. */
  market: string;
  countryCode: string;
  /** Sometimes has trailing spaces ("ABTV "). */
  network: string;
  sequenceNumber?: number;
}

export function parseWeek(raw: NhlScheduleResponse): ScheduleWeek {
  return {
    nextStartDate: raw.nextStartDate,
    days: (raw.gameWeek ?? []).map((d) => ({
      date: d.date,
      games: (d.games ?? []).map((g) => parseGame(g, d.date)).sort((a, b) => a.startTime - b.startTime || a.id - b.id),
    })),
  };
}

function parseGame(g: NhlGame, day: string): Game {
  const broadcasts = [...(g.tvBroadcasts ?? [])]
    .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
    .flatMap((b): Broadcast[] => {
      const network = b.network.trim();
      return isMarket(b.market) && network ? [{ country: b.countryCode, market: b.market, network }] : [];
    });
  return {
    id: g.id,
    day,
    startTime: Date.parse(g.startTimeUTC),
    away: g.awayTeam.abbrev,
    home: g.homeTeam.abbrev,
    venue: g.venue?.default ?? "",
    state: g.gameState,
    scheduleState: g.gameScheduleState,
    gameType: g.gameType,
    awayScore: g.awayTeam.score,
    homeScore: g.homeTeam.score,
    broadcasts,
    url: `https://www.nhl.com${g.gameCenterLink ?? `/gamecenter/${g.id}`}`,
  };
}

/** The Eastern calendar date (YYYY-MM-DD) at `time`, shifted by `addDays`. */
export function easternDate(time: number, addDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time));
  if (addDays === 0) return parts;
  const d = new Date(`${parts}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-10" → "Saturday, Oct 10" */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
