import type { TransactionType } from "../types";

// The three layers of dedupe from migrations/0001_init.sql:
//   1. seen_items       never process the same source item twice
//   2. events           one row per real-world move, however many sources report it
//   3. posted_messages  an event reaches a channel at most once

export interface NewsEvent {
  id: number;
  type: TransactionType;
  teams: string[];
  players: string[];
  headline: string;
  /** Reddit thread. */
  url: string;
  /** Original report (tweet or nhl.com article), if the post linked one. */
  link: string | null;
  source: string;
  itemId: string | null;
  /** Unix ms when the source item was published. */
  publishedAt: number;
}

interface EventRow {
  id: number;
  type: TransactionType;
  teams: string;
  players: string;
  headline: string;
  url: string;
  link: string | null;
  source: string;
  item_id: string | null;
  published_at: number | null;
  created_at: number;
}

const toEvent = (r: EventRow): NewsEvent => ({
  id: r.id,
  type: r.type,
  teams: JSON.parse(r.teams) as string[],
  players: JSON.parse(r.players) as string[],
  headline: r.headline,
  url: r.url,
  link: r.link,
  source: r.source,
  itemId: r.item_id,
  publishedAt: r.published_at ?? r.created_at,
});

/** D1 allows at most 100 bound parameters per query. */
const MAX_PARAMS = 90;

/** The ids from `ids` that haven't been processed yet, in the same order. */
export async function filterUnseen(db: D1Database, source: string, ids: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const chunk = ids.slice(i, i + MAX_PARAMS);
    const { results } = await db
      .prepare(`SELECT source_id FROM seen_items WHERE source = ? AND source_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(source, ...chunk)
      .all<{ source_id: string }>();
    for (const r of results) seen.add(r.source_id);
  }
  return ids.filter((id) => !seen.has(id));
}

export async function markSeen(db: D1Database, source: string, id: string, now: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO seen_items (source, source_id, first_seen) VALUES (?, ?, ?)")
    .bind(source, id, now)
    .run();
}

/** Events of `type` published after `since`, newest first. */
export async function recentEvents(db: D1Database, type: TransactionType, since: number): Promise<NewsEvent[]> {
  const { results } = await db
    .prepare("SELECT * FROM events WHERE type = ? AND COALESCE(published_at, created_at) >= ? ORDER BY id DESC")
    .bind(type, since)
    .all<EventRow>();
  return results.map(toEvent);
}

export async function findEventByItem(db: D1Database, itemId: string): Promise<NewsEvent | undefined> {
  const row = await db.prepare("SELECT * FROM events WHERE item_id = ?").bind(itemId).first<EventRow>();
  return row ? toEvent(row) : undefined;
}

/** Inserts an event, or returns undefined if one with the same fingerprint already exists. */
export async function insertEvent(
  db: D1Database,
  e: Omit<NewsEvent, "id">,
  fingerprint: string,
  now: number,
): Promise<NewsEvent | undefined> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO events
         (type, teams, players, headline, url, link, source, item_id, published_at, fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.type,
      JSON.stringify(e.teams),
      JSON.stringify(e.players),
      e.headline,
      e.url,
      e.link,
      e.source,
      e.itemId,
      e.publishedAt,
      fingerprint,
      now,
    )
    .run();
  return result.meta.changes > 0 ? { ...e, id: Number(result.meta.last_row_id) } : undefined;
}

export async function findEventByFingerprint(db: D1Database, fingerprint: string): Promise<NewsEvent | undefined> {
  const row = await db.prepare("SELECT * FROM events WHERE fingerprint = ?").bind(fingerprint).first<EventRow>();
  return row ? toEvent(row) : undefined;
}

/** Channels this event has already been posted to. */
export async function postedChannels(db: D1Database, eventId: number): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT channel_id FROM posted_messages WHERE event_id = ?")
    .bind(eventId)
    .all<{ channel_id: string }>();
  return new Set(results.map((r) => r.channel_id));
}

export async function recordPost(
  db: D1Database,
  post: { eventId: number; channelId: string; messageId: string },
  now: number,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO posted_messages (event_id, channel_id, message_id, posted_at) VALUES (?, ?, ?, ?)")
    .bind(post.eventId, post.channelId, post.messageId, now)
    .run();
}

export async function getState(db: D1Database, key: string): Promise<string | undefined> {
  return (await db.prepare("SELECT value FROM bot_state WHERE key = ?").bind(key).first<string>("value")) ?? undefined;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}
