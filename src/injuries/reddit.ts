// Breaking injury news from r/hockey. Injury scoops come mostly from team beat
// reporters ("[Russo] …", "[Walker] …"), too many to keep a list of, so any
// reporter tag counts, guarded by two other checks: firm wording, and the
// named player has to be on that team's NHL roster. Everything that passes
// attaches to the same episode ESPN's list uses, so it's posted once.
import { findPlayers, findTeams, splitTag, teamsFromOfficialLinks, trustedSource, type ClassifyInput } from "../news/classify";
import { openEpisodes } from "../db/injuries";
import { getRoster } from "../db/rosters";
import { playerKey, type InjuryStatus } from "../sources/espn-injuries";
import type { RosterPlayer } from "../sources/nhl";

export type InjuryVerdict =
  /** Nothing about injuries: leave the post to the trade/waiver/signing filter. */
  | { kind: "not-injury" }
  | { kind: "rejected"; reason: string }
  | {
      kind: "candidate";
      /** Teams named, in order of mention. */
      teams: string[];
      /** Capitalised names in the title, to check against rosters. */
      names: string[];
      status: InjuryStatus;
      injury?: string;
      reporter: string;
    };

/** Talks about an injury at all. */
const INJURY_WORDS =
  /\b(injur\w*|IR|LTIR|injured reserve|surgery|concussion|fractur\w*|torn|broken|sidelined|day[- ]to[- ]day|week[- ]to[- ]week|month[- ]to[- ]month|out (for|indefinitely)|will miss|lower[- ]body|upper[- ]body)\b/i;

/** Not confirmed: in-game scares, evaluations, guesses. */
const SPECULATION =
  /\b(left (the )?(game|ice|practice|morning skate)|leaving the (game|ice)|apparent( \w+)? injury|(will be|being|to be) evaluated|game[- ]time decision|questionable|expected|expects|could|might|may|possibl\w*|likely|unlikely|hope\w*|rumou?r\w*|not sure|no update)\b|\?/i;

/** Firm statuses, most serious first. */
const IR = /\b((placed|placing|places|put|puts|putting|moved|moving|going|goes|landed|lands) (\S+ ){0,4}on (long-term )?(injured reserve|IR|LTIR)|(on|to) (the )?(LTIR|IR|long-term injured reserve|injured reserve))\b/i;
const OUT =
  /\b(out for the (season|year|playoffs)|out (indefinitely|week-to-week|month-to-month)|week[- ]to[- ]week|month[- ]to[- ]month|out (at least |about |approximately )?(\d+|one|two|three|four|five|six|eight|ten)([-–](\d+|\w+))? (weeks|months)|will miss|is out|are out|won't (play|dress|be available)|will not (play|dress|skate|be (available|skating|playing))|underwent (\w+ ){0,3}surgery|had (\w+ ){0,3}surgery|(sustained|suffered|has) an? (\w+ )?(fracture|torn|broken)|fractured|torn)\b/i;
const DAY_TO_DAY = /\bday[- ]to[- ]day\b/i;

const BODY_PARTS =
  /\b(upper[- ]body|lower[- ]body|concussion|skull|jaw|head|neck|shoulder|elbow|wrist|hand|finger|back|hip|groin|knee|ankle|foot|leg|ACL|MCL|achilles)\b/i;

/** Bracketed tags that aren't sources: game clips "[VAN 5 - EDM (3)]", "[TOR-MTL]", and flair-like words. */
const NOT_REPORTERS = new Set(["serious", "oc", "meta", "discussion", "highlight", "question", "video", "stats", "stat", "fluff", "misc", "pgt", "gdt", "rumor", "rumour", "report"]);

export function classifyInjury(input: ClassifyInput): InjuryVerdict {
  const { tag, rest } = splitTag(input.title);
  if (!INJURY_WORDS.test(rest)) return { kind: "not-injury" };

  const reporter = trustedSource(tag, input.links) ?? (tag && looksLikeReporter(tag) ? tag : undefined);
  if (!reporter) return { kind: "rejected", reason: "injury news without a named reporter or official source" };

  // Quotes are people talking ("…when guys like that are out"), not statuses.
  const text = withoutQuotes(rest);
  // Only the text up to the sentence stating the injury has to be free of
  // hedging: "Larkin is out for two games. They hope he's back soon." is fine.
  const sentences = text.split(/(?<=[.!])\s+/);
  const statedAt = sentences.findIndex((s) => statusOf(s));
  if (statedAt === -1) {
    const hedge = text.match(SPECULATION);
    return {
      kind: "rejected",
      reason: hedge ? `injury not confirmed (“${hedge[0]}”)` : "injury news without a firm status (IR, out, will miss, surgery…)",
    };
  }
  const upToStatus = sentences.slice(0, statedAt + 1).join(" ");
  const speculation = upToStatus.match(SPECULATION);
  if (speculation) return { kind: "rejected", reason: `injury not confirmed (“${speculation[0]}”)` };
  const status = statusOf(upToStatus)!;

  const teams = [...findTeams(input.title), ...teamsFromOfficialLinks(input.links)].map((t) => t.code);
  if (teams.length === 0) return { kind: "rejected", reason: "injury news without an NHL team named" };

  const injury = text.match(BODY_PARTS)?.[0];
  return {
    kind: "candidate",
    teams: [...new Set(teams)],
    names: findPlayers(text),
    status,
    injury: injury ? injury.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : undefined,
    reporter,
  };
}

export interface ResolvedPlayer {
  team: string;
  player: string;
  playerKey: string;
  position: string;
}

/**
 * The first name in the title that belongs to one of the named teams: on
 * its NHL roster, or already on ESPN's injury list for it (players on the
 * injured non-roster list don't appear on the roster).
 */
export async function resolvePlayer(
  db: D1Database,
  candidate: { teams: readonly string[]; names: readonly string[] },
  now: number,
): Promise<ResolvedPlayer | undefined> {
  for (const team of candidate.teams) {
    const injured = (await openEpisodes(db, [team])).map((e) => ({ name: e.player, position: e.position ?? "" }));
    const match = matchRoster([...(await getRoster(db, team, now)), ...injured], candidate.names);
    if (match) return { team, player: match.name, playerKey: playerKey(match.name), position: match.position };
  }
  return undefined;
}

/**
 * Exact full name first. Otherwise the surname, if it's unique on the
 * roster and (for a full name) the first initial agrees: "Mathew Barzal"
 * finds "Mat Barzal", a lone "Korpisalo" finds "Joonas Korpisalo".
 */
export function matchRoster(roster: readonly RosterPlayer[], names: readonly string[]): RosterPlayer | undefined {
  for (const name of names) {
    const key = playerKey(name);
    const exact = roster.find((p) => playerKey(p.name) === key);
    if (exact) return exact;
    const parts = key.split(" ");
    const surname = parts.at(-1)!;
    if (surname.length <= 2) continue;
    const bySurname = unique(roster.filter((p) => playerKey(p.name).split(" ").at(-1) === surname));
    const initial = parts.length > 1 ? parts[0]![0] : undefined;
    if (bySurname.length === 1 && (!initial || playerKey(bySurname[0]!.name)[0] === initial)) return bySurname[0];
  }
  return undefined;
}

function unique(players: RosterPlayer[]): RosterPlayer[] {
  return [...new Map(players.map((p) => [playerKey(p.name), p])).values()];
}

function statusOf(text: string): InjuryStatus | undefined {
  return IR.test(text) ? "ir" : OUT.test(text) ? "out" : DAY_TO_DAY.test(text) ? "day-to-day" : undefined;
}

/** Drops “quoted” and "quoted" passages. */
function withoutQuotes(text: string): string {
  return text.replace(/“[^”]*”|"[^"]*"/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeReporter(tag: string): boolean {
  if (NOT_REPORTERS.has(tag.toLowerCase())) return false;
  // Letters, spaces and name punctuation only: rules out "[VAN 5 - EDM (3)]" and "[TOR-MTL]".
  if (!/^\p{L}[\p{L} .'’&]{1,40}$/u.test(tag)) return false;
  return true;
}
