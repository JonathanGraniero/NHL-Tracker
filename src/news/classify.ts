// Decides whether a post reports a *completed* NHL transaction from a source
// we trust, and if so which kind and which teams. Everything here works on
// the post title (plus the links in the post, to spot official sources).
//
// It errs on the side of not posting: a missed move shows up again when the
// team announces it, but a false "trade!" in someone's channel is worse.
import { TEAMS, getTeam, type Team } from "../data/teams";
import type { TransactionType } from "../types";

export type Verdict =
  | { confirmed: true; type: TransactionType; teams: string[]; players: string[]; source: string }
  | { confirmed: false; reason: string };

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

/** Wording that means the move hasn't actually happened yet. */
const SPECULATION =
  /\b(not a done deal|not done|not final|not sure|closing in|nearing|close to|expect\w*|could|might|may|would|will|possib\w*|potential\w*|proposed|rumou?rs?|talks?|talking|discuss\w*|negotiat\w*|interest\w*|believe\w*|sounds like|hearing|working (on|through|toward)|rework\w*|request\w*|grades?|reacts?|opens up|tried|trying|offer(s|ed)?|almost|if|whether|permission|must|eligible|at risk)\b|\?/i;

const WAIVER =
  /\b(claim(s|ed)?|claiming)\b.*\bwaivers\b|\b(placed|placing|places|put|puts|putting)\b.*\bon waivers\b|\bclear(s|ed)? waivers\b|\bwaived\b|\bon waivers\b/i;
const TRADE = /\b(acquire[sd]?|acquiring|traded|in exchange for|trade (is )?(done|complete|official))\b/i;
const SIGNING = /\b(sign(s|ed)?|re-sign(s|ed)?|ink(s|ed)?|agreed? to (terms|an?)|extended|extension)\b/i;

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
  "year", "years", "forward", "defenceman", "defenseman", "goaltender", "goalie", "center", "centre", "winger", "f", "d", "g",
]);

export function classify(input: ClassifyInput): Verdict {
  const { tag, rest } = splitTag(input.title);

  const source = trustedSource(tag, input.links);
  if (!source) return { confirmed: false, reason: "not from a trusted insider or an official NHL/team source" };

  const outOfScope = input.title.match(OUT_OF_SCOPE);
  if (outOfScope) return { confirmed: false, reason: `not an NHL player move (“${outOfScope[0]}”)` };

  const teams = findTeams(input.title);
  if (teams.length === 0) teams.push(...teamsFromOfficialLinks(input.links));

  // Only the text up to the sentence that states the move has to be free of
  // hedging: "X has agreed to an extension. He will be the highest paid…" is fine.
  const sentences = rest.split(/(?<=[.!])\s+/);
  const statedAt = sentences.findIndex((s) => transactionType(s, teams));
  const upToMove = statedAt === -1 ? rest : sentences.slice(0, statedAt + 1).join(" ");
  const speculation = upToMove.match(SPECULATION);
  if (speculation) return { confirmed: false, reason: `not confirmed yet (“${speculation[0]}”)` };

  const type = transactionType(upToMove, teams);
  if (!type) return { confirmed: false, reason: "no completed trade, waiver or signing wording" };
  if (teams.length === 0) return { confirmed: false, reason: "no NHL team named" };

  return { confirmed: true, type, teams: teams.map((t) => t.code), players: findPlayers(rest), source };
}

/** Team news on nhl.com lives under nhl.com/<team>/, e.g. nhl.com/sabres/news/…. */
function teamsFromOfficialLinks(links: readonly string[]): Team[] {
  for (const link of links) {
    const m = link.match(/^https?:\/\/(?:www\.)?nhl\.com\/([a-z]+)\//i);
    const slug = m?.[1]?.toLowerCase();
    const team = slug && TEAMS.find((t) => t.aliases.some((a) => a.replace(/[^a-z]/g, "") === slug));
    if (team) return [team];
  }
  return [];
}

/** "[Friedman] Columbus: …" → { tag: "Friedman", rest: "Columbus: …" } */
function splitTag(title: string): { tag?: string; rest: string } {
  const m = title.match(/^\[([^\]]+)\]\s*:?\s*/);
  return m ? { tag: m[1]?.trim(), rest: title.slice(m[0].length) } : { rest: title };
}

function trustedSource(tag: string | undefined, links: readonly string[]): string | undefined {
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

function transactionType(text: string, teams: readonly Team[]): TransactionType | undefined {
  if (WAIVER.test(text)) return "waiver";
  if (TRADE.test(text) || isTwoSidedTrade(text)) return "trade";
  if (SIGNING.test(text) && teams.length > 0) return "signing";
  return undefined;
}

/** Insiders often write trades as "Columbus: Knies, Lorentz … Tor: Marchenko, Wood …". */
function isTwoSidedTrade(text: string): boolean {
  const sides = new Set<string>();
  for (const [, label = ""] of text.matchAll(/(?:^|[\s.;/])([A-Za-z.]+(?: [A-Za-z.]+){0,2}):\s/g)) {
    const team = teamByName(normalize(label)) ?? getTeam(label);
    if (team) sides.add(team.code);
  }
  return sides.size >= 2;
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
function findPlayers(text: string): string[] {
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
        return w.length > 1 && !/\d|-(year|way|level)$/i.test(w) && !teamWords.has(n) && !WORDS_THAT_ARE_NOT_NAMES.has(n);
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
