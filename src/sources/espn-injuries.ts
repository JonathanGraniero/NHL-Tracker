// ESPN's league-wide NHL injury list. Undocumented but public (no key), and
// the only structured injury source: NHL.com's API has no injury data. One
// request returns every injured player (~1.2 MB, ~2 ms to parse), so it's
// polled on its own cron rather than every 2 minutes.
import { getTeam } from "../data/teams";

const URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";

export type InjuryStatus = "day-to-day" | "out" | "ir" | "suspended";

/** One injured (or suspended) player, as the tracker uses it. */
export interface InjuryReport {
  /** Our team code. */
  team: string;
  /** Normalised name, the player's identity within a team (see playerKey). */
  playerKey: string;
  player: string;
  position?: string;
  status: InjuryStatus;
  /** Body part ("Lower Body", "Knee"), with side when known ("Left Knee"). */
  injury?: string;
  /** ESPN's estimated return date, YYYY-MM-DD. */
  returnDate?: string;
  /** ESPN's one-line note, which usually names the original reporter. */
  note?: string;
  /** ESPN player page. */
  url?: string;
  /** When ESPN last updated this entry, unix ms. */
  updatedAt: number;
}

/** The parts of ESPN's response the bot reads. */
export interface EspnInjuriesResponse {
  injuries?: EspnTeamInjuries[];
}

export interface EspnTeamInjuries {
  displayName: string;
  injuries?: EspnInjury[];
}

export interface EspnInjury {
  /** "Day-To-Day", "Out", "Injured Reserve", "Suspension". */
  status: string;
  /** ISO time of ESPN's last update to this entry. */
  date: string;
  shortComment?: string;
  /** DD, O, IR, SUSP. */
  type?: { abbreviation?: string };
  details?: { type?: string; side?: string; returnDate?: string };
  athlete: {
    displayName: string;
    position?: { abbreviation?: string };
    team?: { abbreviation?: string };
    links?: { href?: string }[];
  };
}

export class EspnError extends Error {
  constructor(readonly status: number) {
    super(`ESPN responded ${status}`);
  }
}

const STATUSES: Record<string, InjuryStatus> = { DD: "day-to-day", O: "out", IR: "ir", SUSP: "suspended" };

/** ESPN abbreviations that differ from ours. */
const TEAM_CODES: Record<string, string> = { LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL" };

/** Absences ESPN lists that aren't injuries (holdouts, personal leave). */
const NOT_INJURIES = new Set(["contract dispute", "not injury related"]);

export async function fetchInjuries(): Promise<InjuryReport[]> {
  const res = await fetch(URL, {
    headers: { "User-Agent": "nhl-tracker (+https://github.com/JonathanGraniero/NHL-Tracker)" },
  });
  if (!res.ok) throw new EspnError(res.status);
  return parseInjuries(await res.json<EspnInjuriesResponse>());
}

export function parseInjuries(raw: EspnInjuriesResponse): InjuryReport[] {
  const reports = new Map<string, InjuryReport>();
  for (const team of raw.injuries ?? []) {
    for (const entry of team.injuries ?? []) {
      const report = parseInjury(entry);
      // A player listed twice keeps the most recently updated entry.
      const key = report && `${report.team}/${report.playerKey}`;
      if (report && key && (reports.get(key)?.updatedAt ?? -1) < report.updatedAt) reports.set(key, report);
    }
  }
  return [...reports.values()];
}

function parseInjury(e: EspnInjury): InjuryReport | undefined {
  const abbrev = e.athlete.team?.abbreviation;
  const team = abbrev ? getTeam(TEAM_CODES[abbrev] ?? abbrev)?.code : undefined;
  const status = STATUSES[e.type?.abbreviation ?? ""] ?? statusFromText(e.status);
  const kind = e.details?.type?.trim();
  if (!team || !status || (kind && NOT_INJURIES.has(kind.toLowerCase()))) return undefined;

  const note = e.shortComment?.trim();
  return {
    team,
    playerKey: playerKey(e.athlete.displayName),
    player: e.athlete.displayName,
    position: e.athlete.position?.abbreviation,
    status,
    injury: status === "suspended" || !kind || kind === "Undisclosed" ? undefined : [e.details?.side, kind].filter(Boolean).join(" "),
    returnDate: e.details?.returnDate?.slice(0, 10),
    // Some entries are just "ir"; that says nothing the status doesn't.
    note: note && note.length > 3 ? note : undefined,
    url: e.athlete.links?.find((l) => l.href?.includes("/player/"))?.href,
    updatedAt: Date.parse(e.date),
  };
}

function statusFromText(status: string): InjuryStatus | undefined {
  const s = status.toLowerCase();
  if (s.includes("day")) return "day-to-day";
  if (s.includes("reserve")) return "ir";
  if (s.includes("suspen")) return "suspended";
  if (s === "out") return "out";
  return undefined;
}

/** "A.J. Greer" → "aj greer", "Jesperi Kotkaniemi" → "jesperi kotkaniemi"; accents and punctuation dropped. */
export function playerKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s-]/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
