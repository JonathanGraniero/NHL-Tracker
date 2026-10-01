// Whether a game is on ESPN+ for US viewers, under the ESPN/NHL deal.
//
// NHL.com lists ESPN's streaming exclusives itself (ESPN+ · Hulu · Disney+).
// What it doesn't list is "NHL Power Play": ESPN+ (the ESPN Select plan)
// streams every out-of-market game that isn't a national exclusive, blacked
// out in the teams' home areas. That part is our reading of the deal, not
// per-game data, so games we can't classify confidently get no label.
// https://www.espn.com/nhl/story/_/id/49731635/nhl-espn-schedule-where-watch-2026-27-games
import { isCanadianTeam } from "../data/teams";
import type { Game } from "../sources/nhl";

/** US national partners whose games are exclusive (not on Power Play). */
const EXCLUSIVE_PARTNERS = new Set(["ABC", "ESPN", "ESPN2", "TNT", "truTV", "HBO MAX", "ESPN+", "HULU", "Disney+"]);

export type EspnPlus =
  /** Streams on ESPN+ outside the listed teams' home areas. */
  | { kind: "out-of-market"; blackedOut: string[] }
  /** A national exclusive (ESPN, ABC, TNT…): not on Power Play, and already listed as a network. */
  | { kind: "national" }
  /** A national game that also has a local channel: we don't know how ESPN handles these. */
  | { kind: "unknown" };

export function espnPlus(game: Game): EspnPlus {
  const us = game.broadcasts.filter((b) => b.country === "US");
  const exclusive = us.some((b) => b.market === "N" && EXCLUSIVE_PARTNERS.has(b.network));
  if (exclusive) return us.some((b) => b.market !== "N") ? { kind: "unknown" } : { kind: "national" };
  // Blackouts follow teams' US home areas, so only US teams are named.
  const blackedOut = [game.away, game.home].filter((t) => !isCanadianTeam(t));
  return { kind: "out-of-market", blackedOut };
}
