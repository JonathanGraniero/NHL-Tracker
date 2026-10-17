// Decides whether a post reports a *completed* NHL transaction from a source
// we trust, and if so which kind and which teams. Everything here works on
// the post title (plus the links in the post, to spot official sources).
// Code checks the source, the scope and the teams; Claude reads the wording
// (model.ts), and only for posts that pass those checks.
//
// It errs on the side of not posting: a missed move shows up again when the
// team announces it, but a false "trade!" in someone's channel is worse.
import { TEAMS, getTeam, type Team } from "../data/teams";
import type { TransactionType } from "../types";
import type { ReadHeadline, SourceKind } from "./model";

export type Verdict =
  | { confirmed: true; type: TransactionType; teams: string[]; players: string[]; source: string }
  /** `unavailable`: Claude couldn't be asked, so the post should be tried again later. */
  | { confirmed: false; reason: string; unavailable?: true };

export interface ClassifyInput {
  title: string;
  links: readonly string[];
}

/** Insiders whose "[Name]" tag on r/hockey we trust, by every spelling that shows up. */
const INSIDERS: Record<string, string> = {
  friedman: "Elliotte Friedman",
  "elliotte friedman": "Elliotte Friedman",
  lebrun: "Pierre LeBrun",
  "pierre lebrun": "Pierre LeBrun",
  johnston: "Chris Johnston",
  "chris johnston": "Chris Johnston",
  dreger: "Darren Dreger",
  "darren dreger": "Darren Dreger",
  mckenzie: "Bob McKenzie",
  "bob mckenzie": "Bob McKenzie",
  seravalli: "Frank Seravalli",
  "frank seravalli": "Frank Seravalli",
  kaplan: "Emily Kaplan",
  "emily kaplan": "Emily Kaplan",
  puckpedia: "PuckPedia",
  nhl: "NHL",
  "nhl pr": "NHL Public Relations",
  nhlpr: "NHL Public Relations",
  "nhl public relations": "NHL Public Relations",
};

/** X/Twitter handles of the same insiders, for posts that only link the tweet. */
const INSIDER_HANDLES: Record<string, string> = {
  friedgehnic: "Elliotte Friedman",
  pierrevlebrun: "Pierre LeBrun",
  reporterchris: "Chris Johnston",
  darrendreger: "Darren Dreger",
  tsnbobmckenzie: "Bob McKenzie",
  frank_seravalli: "Frank Seravalli",
  emilymkaplan: "Emily Kaplan",
  puckpedia: "PuckPedia",
  nhlpr: "NHL Public Relations",
};

/** Moves outside the NHL, or of staff rather than players. */
const OUT_OF_SCOPE =
  /\b(AHL|KHL|ECHL|OHL|WHL|QMJHL|CHL|SHL|NCAA|PWHL|head coach|coach|coaches|GM|general manager|president|scout|broadcast\w*|PTO|tryout)\b/i;

/** Uppercase short forms that aren't team codes. */
const EXTRA_ABBREVIATIONS: Record<string, string> = { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", LV: "VGK" };

/** "Colorado's 2028 first-round pick" names a pick's original owner, not a team in the deal. */
const PICK_OWNER = /^['’]s\s+(\d{4}\s+)?(conditional\s+)?(first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|4th|5th|6th|7th)\b/i;

/** Capitalised words in headlines that aren't part of a player's name. */
const WORDS_THAT_ARE_NOT_NAMES = new Set([
  "the", "a", "an", "and", "to", "on", "of", "for", "with", "in", "at", "from", "by", "up", "we", "he", "his", "they",
  "today", "sources", "source", "deal", "nhl", "aav", "ufa", "rfa", "nmc", "ntc", "official", "officially",
  "breaking", "update", "per", "release", "includes", "performance", "bonus", "bonuses", "cap", "hit",
  "sign", "signs", "signed", "re-sign", "re-signs", "ink", "inks", "inked", "agree", "agrees", "agreed", "terms",
  "extension", "extensions", "extended", "contract", "claim", "claims", "claimed", "waivers", "acquire",
  "acquires", "acquired", "trade", "traded", "announce", "announces", "announced",
  "complete", "completes", "completed", "finalize", "finalizes", "finalized", "finalise", "finalises", "finalised", "blockbuster",
  "year", "years", "major", "business", "place", "places", "placed", "transactions", "forward", "defenceman", "defenseman", "goaltender", "goalie", "center", "centre", "winger", "f", "d", "g",
]);

export async function classify(input: ClassifyInput, readHeadline: ReadHeadline): Promise<Verdict> {
  const { tag, rest } = splitTag(input.title);

  const source = trustedSource(tag, input.links);
  if (!source) return { confirmed: false, reason: "not from a trusted insider or an official NHL/team source" };

  const outOfScope = input.title.match(OUT_OF_SCOPE);
  if (outOfScope) return { confirmed: false, reason: `not an NHL player move (“${outOfScope[0]}”)` };

  const teams = findTeams(input.title);
  if (teams.length === 0) teams.push(...teamsFromOfficialLinks(input.links));
  if (teams.length === 0) return { confirmed: false, reason: "no NHL team named" };

  const reading = await readHeadline({ text: rest, source, sourceKind: sourceKind(source) });
  if (!reading.ok) return { confirmed: false, reason: reading.reason, ...(reading.unavailable && { unavailable: true as const }) };
  if (reading.move === "none") return { confirmed: false, reason: `not a trade, waiver or signing (${reading.reason})` };
  if (!reading.done) return { confirmed: false, reason: `not confirmed yet (${reading.reason})` };

  // Teams come from the code above; a name Claude gives must be in the title.
  const fold = (s: string) => normalize(s).replace(/’/g, "'");
  const players = reading.players.filter((p) => p.trim() !== "" && fold(input.title).includes(fold(p)));
  return { confirmed: true, type: reading.move, teams: teams.map((t) => t.code), players, source };
}

function sourceKind(source: string): SourceKind {
  if (source === "NHL.com") return "official site";
  return TEAMS.some((t) => t.name === source) ? "team account" : "insider";
}

/** Team news on nhl.com lives under nhl.com/<team>/, e.g. nhl.com/sabres/news/…. */
export function teamsFromOfficialLinks(links: readonly string[]): Team[] {
  for (const link of links) {
    const m = link.match(/^https?:\/\/(?:www\.)?nhl\.com\/([a-z]+)\//i);
    const slug = m?.[1]?.toLowerCase();
    const team = slug && TEAMS.find((t) => t.aliases.some((a) => a.replace(/[^a-z]/g, "") === slug));
    if (team) return [team];
  }
  return [];
}

/** "[Friedman] Columbus: …" → { tag: "Friedman", rest: "Columbus: …" } */
export function splitTag(title: string): { tag?: string; rest: string } {
  const m = title.match(/^\[([^\]]+)\]\s*:?\s*/);
  return m ? { tag: m[1]?.trim(), rest: title.slice(m[0].length) } : { rest: title };
}

export function trustedSource(tag: string | undefined, links: readonly string[]): string | undefined {
  if (tag) {
    const key = normalize(tag);
    const insider = INSIDERS[key];
    if (insider) return insider;
    const team = teamByName(key);
    if (team) return team.name;
  }
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, "");
    if (host === "nhl.com") return "NHL.com";
    if (/^(x\.com|twitter\.com|xcancel\.com|nitter\.[a-z.]+)$/.test(host)) {
      const handle = url.pathname.split("/")[1]?.toLowerCase();
      const insider = handle ? INSIDER_HANDLES[handle] : undefined;
      if (insider) return insider;
    }
  }
  return undefined;
}

/** Teams named in the text, in order of first mention. */
export function findTeams(text: string): Team[] {
  const found = new Map<string, number>();
  const note = (code: string, index: number) => {
    if (!found.has(code) || found.get(code)! > index) found.set(code, index);
  };

  const lower = normalize(text);
  for (const team of TEAMS) {
    for (const name of [team.name, ...team.aliases]) {
      const re = new RegExp(`(?<![\\w'’])${escapeRegExp(normalize(name))}(?![\\w])`, "g");
      for (const m of lower.matchAll(re)) {
        if (PICK_OWNER.test(lower.slice(m.index + m[0].length))) continue;
        note(team.code, m.index);
      }
    }
  }
  // Codes count only in capitals ("TOR", "CBJ"), since several are ordinary
  // words in lower case ("min", "car", "col"), or before a colon ("Tor:").
  for (const m of text.matchAll(/\b([A-Z]{2,3})\b/g)) {
    const code = EXTRA_ABBREVIATIONS[m[1]!] ?? m[1]!;
    if (getTeam(code)) note(getTeam(code)!.code, m.index);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z]{2}):/g)) {
    const team = getTeam(m[1]!);
    if (team) note(team.code, m.index);
  }

  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => getTeam(code)!);
}

/** Best-effort player names: capitalised words that aren't teams, sources or filler. */
export function findPlayers(text: string): string[] {
  const teamWords = new Set(
    TEAMS.flatMap((t) => [t.code, t.name, ...t.aliases, ...t.name.split(" ")]).map((w) => normalize(w)),
  );
  const names: string[] = [];
  for (const [phrase] of text.matchAll(/\b[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+)*/gu)) {
    const words = phrase
      .split(/\s+/)
      .map((w) => w.replace(/['’]s$/, "").replace(/[.,;:]+$/, ""))
      .filter((w) => {
        const n = normalize(w);
        return w.length > 1 && !/\d|-(year|way|level|team)$/i.test(w) && !teamWords.has(n) && !WORDS_THAT_ARE_NOT_NAMES.has(n);
      });
    if (words.length > 0) names.push(words.join(" "));
  }
  return [...new Set(names)];
}

function teamByName(key: string): Team | undefined {
  return TEAMS.find((t) => normalize(t.name) === key || t.aliases.some((a) => normalize(a) === key));
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
