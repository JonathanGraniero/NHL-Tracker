import { ALL_TYPES, type TransactionType } from "../types";

/** Stored in subscriptions.team_code to mean "every team". */
export const ALL_TEAMS = "*";

export interface Subscription {
  teamCode: string;
  types: TransactionType[];
}

function parseTypes(csv: string): TransactionType[] {
  return csv.split(",").filter((t): t is TransactionType => (ALL_TYPES as readonly string[]).includes(t));
}

/** Adds a subscription, or replaces the types on an existing one. */
export async function upsertSubscription(
  db: D1Database,
  sub: { guildId: string; channelId: string; teamCode: string; types: readonly TransactionType[] },
): Promise<"created" | "updated"> {
  const existing = await db
    .prepare("SELECT 1 FROM subscriptions WHERE channel_id = ? AND team_code = ?")
    .bind(sub.channelId, sub.teamCode)
    .first();
  await db
    .prepare(
      `INSERT INTO subscriptions (guild_id, channel_id, team_code, types) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id, team_code) DO UPDATE SET types = excluded.types`,
    )
    .bind(sub.guildId, sub.channelId, sub.teamCode, sub.types.join(","))
    .run();
  return existing ? "updated" : "created";
}

/** Returns true if there was a subscription to remove. */
export async function removeSubscription(db: D1Database, channelId: string, teamCode: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM subscriptions WHERE channel_id = ? AND team_code = ?")
    .bind(channelId, teamCode)
    .run();
  return result.meta.changes > 0;
}

/** Removes every subscription in a channel and returns how many there were. */
export async function clearChannel(db: D1Database, channelId: string): Promise<number> {
  const result = await db.prepare("DELETE FROM subscriptions WHERE channel_id = ?").bind(channelId).run();
  return result.meta.changes;
}

export async function listForChannel(db: D1Database, channelId: string): Promise<Subscription[]> {
  const { results } = await db
    .prepare("SELECT team_code, types FROM subscriptions WHERE channel_id = ? ORDER BY team_code")
    .bind(channelId)
    .all<{ team_code: string; types: string }>();
  return results.map((r) => ({ teamCode: r.team_code, types: parseTypes(r.types) }));
}

/**
 * Channels that should receive a transaction of `type` involving any of
 * `teamCodes`, including channels following all teams. Used when posting.
 * With `guildId`, only that server's channels.
 */
export async function findChannelsFor(
  db: D1Database,
  teamCodes: readonly string[],
  type: TransactionType,
  guildId?: string,
): Promise<string[]> {
  const codes = [...new Set([...teamCodes, ALL_TEAMS])];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT channel_id FROM subscriptions
       WHERE team_code IN (${codes.map(() => "?").join(", ")})
         AND (',' || types || ',') LIKE ?
         ${guildId ? "AND guild_id = ?" : ""}`,
    )
    .bind(...codes, `%,${type},%`, ...(guildId ? [guildId] : []))
    .all<{ channel_id: string }>();
  return results.map((r) => r.channel_id);
}
