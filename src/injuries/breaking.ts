// The r/hockey side of the injury tracker: turns a post that passes the
// injury rules into an observation on the shared episode, then delivers
// whatever that changes (usually a new post, or nothing if ESPN or another
// reporter already has it).
import { Budget, deliver } from "./deliver";
import { observe } from "./episodes";
import { classifyInjury, resolvePlayer } from "./reddit";
import { NhlError } from "../sources/nhl";
import type { InjuryStatus } from "../sources/espn-injuries";
import type { SourceItem } from "../sources/reddit";
import type { Env } from "../env";

export type InjuryOutcome =
  | { kind: "not-injury" }
  | { kind: "rejected"; reason: string }
  | { kind: "recorded"; team: string; player: string; status: InjuryStatus; reporter: string; posted: number; edited: number };

/** Classifies without recording anything (for /replay). */
export async function previewInjury(db: D1Database, item: SourceItem, now: number): Promise<InjuryOutcome> {
  const verdict = classifyInjury(item);
  if (verdict.kind !== "candidate") return verdict;
  const player = await resolvePlayer(db, verdict, now);
  if (!player) return { kind: "rejected", reason: `no ${verdict.teams.join("/")} player named (checked rosters and the injury list)` };
  return { kind: "recorded", team: player.team, player: player.player, status: verdict.status, reporter: verdict.reporter, posted: 0, edited: 0 };
}

export async function processInjuryItem(env: Env, item: SourceItem, now: number, budget: Budget): Promise<InjuryOutcome> {
  const verdict = classifyInjury(item);
  if (verdict.kind !== "candidate") return verdict;
  let player;
  try {
    player = await resolvePlayer(env.DB, verdict, now);
  } catch (err) {
    // NHL.com down with no cached roster. Skipping beats stalling the whole
    // scan on this post every run; ESPN's list will still catch the injury.
    if (err instanceof NhlError) return { kind: "rejected", reason: `couldn't check the roster (${err.message})` };
    throw err;
  }
  if (!player) return { kind: "rejected", reason: `no ${verdict.teams.join("/")} player named (checked rosters and the injury list)` };

  const effects = await observe(env.DB, {
    team: player.team,
    playerKey: player.playerKey,
    player: player.player,
    position: player.position,
    status: verdict.status,
    injury: verdict.injury,
    source: "reddit",
    reporter: verdict.reporter,
    threadUrl: item.url,
    at: item.publishedAt,
  });
  const result = await deliver(env, effects, now, budget);
  return {
    kind: "recorded",
    team: player.team,
    player: player.player,
    status: verdict.status,
    reporter: verdict.reporter,
    posted: result.posted,
    edited: result.edited,
  };
}
