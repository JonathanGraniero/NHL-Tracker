import { classify } from "./classify";
import { buildMessage } from "./embed";
import { createMessage } from "../discord/api";
import {
  filterUnseen,
  findEventByFingerprint,
  findEventByItem,
  getState,
  insertEvent,
  markSeen,
  postedChannels,
  recentEvents,
  recordPost,
  setState,
  type NewsEvent,
} from "../db/events";
import { findChannelsFor } from "../db/subscriptions";
import { RedditError, fetchNewPosts, type SourceItem } from "../sources/reddit";
import { NhlNewsError, fetchTransactions } from "../sources/nhl-news";
import { Budget } from "../injuries/deliver";
import { processInjuryItem, type InjuryOutcome } from "../injuries/breaking";
import type { InjuryStatus } from "../sources/espn-injuries";
import type { Env } from "../env";
import type { TransactionType } from "../types";

/** Older posts are skipped rather than posted late (e.g. after Reddit was unreachable for a while). */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Reports of the same move this far apart are treated as one event. */
const DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
/**
 * Discord calls for injury posts per scan. Workers Free allows 50 outside
 * requests per run, shared with Reddit, roster lookups and trade posts.
 */
const INJURY_BUDGET = 20;
/** Where news comes from. Each keeps its own seen items and first-run baseline. */
interface NewsSource {
  name: SourceItem["source"];
  /** Set once the first scan has marked the existing feed as seen, so the bot doesn't post a backlog. */
  readyKey: string;
  fetch: () => Promise<SourceItem[]>;
  /** Outages that just mean "try again next run". */
  isUnavailable: (err: unknown) => err is RedditError | NhlNewsError;
  /** Also look for breaking injury news (r/hockey only; NHL.com's feed is for moves). */
  injuries: boolean;
}

const SOURCES: readonly NewsSource[] = [
  {
    name: "reddit",
    readyKey: "reddit_ready",
    fetch: fetchNewPosts,
    isUnavailable: (err): err is RedditError => err instanceof RedditError,
    injuries: true,
  },
  {
    name: "nhl",
    readyKey: "nhl_news_ready",
    fetch: fetchTransactions,
    isUnavailable: (err): err is NhlNewsError => err instanceof NhlNewsError,
    injuries: false,
  },
];

export type Outcome =
  | { kind: "rejected"; reason: string }
  | { kind: "duplicate"; event: NewsEvent }
  | { kind: "posted"; event: NewsEvent; channels: string[]; failed: string[] };

/**
 * Runs on the cron: fetch r/hockey and NHL.com's transaction news, then
 * classify, dedupe and post anything new. A move reported in both places is
 * one event, posted once.
 */
export async function runScan(env: Env, now: number): Promise<void> {
  const injuryBudget = new Budget(INJURY_BUDGET);
  for (const source of SOURCES) await scanSource(env, now, source, injuryBudget);
}

async function scanSource(env: Env, now: number, source: NewsSource, injuryBudget: Budget): Promise<void> {
  let items: SourceItem[];
  try {
    items = await source.fetch();
  } catch (err) {
    if (source.isUnavailable(err)) {
      console.warn(`${source.name}: ${err.message}, trying again next run`);
      return;
    }
    throw err;
  }

  const unseen = new Set(await filterUnseen(env.DB, source.name, items.map((i) => i.id)));

  if (!(await getState(env.DB, source.readyKey))) {
    for (const item of items) await markSeen(env.DB, source.name, item.id, now);
    await setState(env.DB, source.readyKey, String(now));
    console.log(`${source.name}: first run, marked ${items.length} existing items as seen without posting`);
    return;
  }

  for (const item of items) {
    if (!unseen.has(item.id)) continue;
    if (now - item.publishedAt > MAX_AGE_MS) {
      log({ item: item.id, title: item.title, outcome: "too old" });
    } else {
      const outcome = await processItem(env, item, { now });
      // Not a confirmed move: maybe breaking injury news.
      const injury =
        source.injuries && outcome.kind === "rejected" ? await processInjuryItem(env, item, now, injuryBudget) : undefined;
      log({ item: item.id, title: item.title, ...(injury && injury.kind !== "not-injury" ? describeInjury(injury) : describe(outcome)) });
    }
    // Marked only after processing: if this run dies mid-post, the next run
    // picks the item up again and processItem finishes the remaining channels.
    await markSeen(env.DB, source.name, item.id, now);
  }
}

/**
 * Classifies one item and, if it's a confirmed move nobody has posted yet,
 * posts it to every subscribed channel that hasn't had it.
 *
 * With `guildId` (the /replay command) it posts only in that server, and
 * also re-posts a move already recorded from another report, so an admin
 * can see how a past move would have looked.
 */
export async function processItem(
  env: Env,
  item: SourceItem,
  opts: { now: number; guildId?: string },
): Promise<Outcome> {
  const verdict = classify(item);
  if (!verdict.confirmed) return { kind: "rejected", reason: verdict.reason };

  const candidate: Omit<NewsEvent, "id"> = {
    type: verdict.type,
    teams: verdict.teams,
    players: verdict.players,
    headline: item.title,
    url: item.url,
    link: pickLink(item.links),
    source: verdict.source,
    itemId: item.id,
    publishedAt: item.publishedAt,
  };
  const fingerprint = fingerprintOf(candidate);

  let event = await findEventByItem(env.DB, item.id);
  if (!event) {
    const duplicate =
      (await findDuplicate(env.DB, candidate)) ?? (await findEventByFingerprint(env.DB, fingerprint));
    if (duplicate && !opts.guildId) return { kind: "duplicate", event: duplicate };
    event = duplicate ?? (await insertEvent(env.DB, candidate, fingerprint, opts.now));
    // Lost a race with another run inserting the same fingerprint.
    event ??= await findEventByFingerprint(env.DB, fingerprint);
    if (!event) return { kind: "rejected", reason: "could not record the event" };
  }

  const already = await postedChannels(env.DB, event.id);
  const targets = (await findChannelsFor(env.DB, event.teams, event.type, opts.guildId)).filter((c) => !already.has(c));
  const message = buildMessage(event);
  const channels: string[] = [];
  const failed: string[] = [];
  for (const channelId of targets) {
    const sent = await createMessage(env.DISCORD_BOT_TOKEN, channelId, message);
    if (sent.ok) {
      await recordPost(env.DB, { eventId: event.id, channelId, messageId: sent.id }, opts.now);
      channels.push(channelId);
    } else {
      console.error(`post to ${channelId} failed (${sent.status}): ${sent.error}`);
      failed.push(channelId);
    }
  }
  return { kind: "posted", event, channels, failed };
}

/**
 * An earlier event describing the same move. Trades match on two shared
 * teams (or one team and a player); waivers and signings need a shared
 * team and a shared player surname.
 */
async function findDuplicate(db: D1Database, e: Omit<NewsEvent, "id">): Promise<NewsEvent | undefined> {
  const candidates = await recentEvents(db, e.type, e.publishedAt - DEDUPE_WINDOW_MS);
  const surnames = new Set(e.players.map(surname));
  return candidates.find((other) => {
    if (Math.abs(other.publishedAt - e.publishedAt) > DEDUPE_WINDOW_MS) return false;
    const sharedTeams = other.teams.filter((t) => e.teams.includes(t)).length;
    const sharedPlayer = other.players.some((p) => surnames.has(surname(p)));
    const noPlayers = e.players.length === 0 || other.players.length === 0;
    if (e.type === "trade") return sharedTeams >= 2 || (sharedTeams >= 1 && sharedPlayer);
    return sharedTeams >= 1 && (sharedPlayer || noPlayers);
  });
}

function fingerprintOf(e: Omit<NewsEvent, "id">): string {
  return [e.type, [...e.teams].sort().join("-"), [...new Set(e.players.map(surname))].sort().join("-")].join(":");
}

function surname(name: string): string {
  return (name.trim().split(/\s+/).at(-1) ?? "").toLowerCase();
}

/** The original report: a tweet or an nhl.com article, else the first link. */
function pickLink(links: readonly string[]): string | null {
  return (
    links.find((l) => /^https?:\/\/(www\.)?(x\.com|twitter\.com|xcancel\.com|nhl\.com)\//i.test(l)) ?? links[0] ?? null
  );
}

/** What happened to one item, as logged. */
type OutcomeLog =
  | { outcome: "too old" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "duplicate"; event: number }
  | { outcome: "posted"; event: number; type: TransactionType; teams: string[]; channels: number; failed: number }
  | { outcome: "injury rejected"; reason: string }
  | { outcome: "injury"; team: string; player: string; status: InjuryStatus; reporter: string; posted: number; edited: number };

/** One JSON line per new item, readable in Workers Logs and `wrangler tail`. */
type ScanLogLine = { item: string; title: string } & OutcomeLog;

function log(line: ScanLogLine): void {
  console.log(JSON.stringify(line));
}

function describeInjury(outcome: Exclude<InjuryOutcome, { kind: "not-injury" }>): OutcomeLog {
  if (outcome.kind === "rejected") return { outcome: "injury rejected", reason: outcome.reason };
  const { team, player, status, reporter, posted, edited } = outcome;
  return { outcome: "injury", team, player, status, reporter, posted, edited };
}

function describe(outcome: Outcome): OutcomeLog {
  switch (outcome.kind) {
    case "rejected":
      return { outcome: "rejected", reason: outcome.reason };
    case "duplicate":
      return { outcome: "duplicate", event: outcome.event.id };
    case "posted":
      return {
        outcome: "posted",
        event: outcome.event.id,
        type: outcome.event.type,
        teams: outcome.event.teams,
        channels: outcome.channels.length,
        failed: outcome.failed.length,
      };
  }
}
