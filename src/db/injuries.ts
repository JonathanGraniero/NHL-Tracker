import type { InjuryReport, InjuryStatus } from "../sources/espn-injuries";

export interface SnapshotRow {
  team: string;
  playerKey: string;
  status: InjuryStatus;
  injury: string | null;
  returnDate: string | null;
  updatedAt: number;
  missing: number;
}

export interface Episode {
  id: number;
  team: string;
  playerKey: string;
  player: string;
  position: string | null;
  status: InjuryStatus;
  injury: string | null;
  returnDate: string | null;
  note: string | null;
  firstSource: "espn" | "reddit";
  reporter: string | null;
  threadUrl: string | null;
  playerUrl: string | null;
  espnConfirmed: boolean;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export type UpdateKind = "reported" | "update" | "returned";

export interface InjuryUpdate {
  id: number;
  episodeId: number;
  kind: UpdateKind;
  fromStatus: InjuryStatus | null;
  toStatus: InjuryStatus | null;
  createdAt: number;
}

interface SnapshotDbRow {
  team: string;
  player_key: string;
  status: InjuryStatus;
  injury: string | null;
  return_date: string | null;
  updated_at: number;
  missing: number;
}

interface EpisodeDbRow {
  id: number;
  team: string;
  player_key: string;
  player: string;
  position: string | null;
  status: InjuryStatus;
  injury: string | null;
  return_date: string | null;
  note: string | null;
  first_source: "espn" | "reddit";
  reporter: string | null;
  thread_url: string | null;
  player_url: string | null;
  espn_confirmed: number;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface UpdateDbRow {
  id: number;
  episode_id: number;
  kind: UpdateKind;
  from_status: InjuryStatus | null;
  to_status: InjuryStatus | null;
  created_at: number;
}

const toEpisode = (r: EpisodeDbRow): Episode => ({
  id: r.id,
  team: r.team,
  playerKey: r.player_key,
  player: r.player,
  position: r.position,
  status: r.status,
  injury: r.injury,
  returnDate: r.return_date,
  note: r.note,
  firstSource: r.first_source,
  reporter: r.reporter,
  threadUrl: r.thread_url,
  playerUrl: r.player_url,
  espnConfirmed: r.espn_confirmed === 1,
  openedAt: r.opened_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
});

const toUpdate = (r: UpdateDbRow): InjuryUpdate => ({
  id: r.id,
  episodeId: r.episode_id,
  kind: r.kind,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  createdAt: r.created_at,
});

// --- ESPN snapshot ---------------------------------------------------------

export async function readSnapshot(db: D1Database): Promise<SnapshotRow[]> {
  const { results } = await db.prepare("SELECT * FROM injury_snapshot").all<SnapshotDbRow>();
  return results.map((r) => ({
    team: r.team,
    playerKey: r.player_key,
    status: r.status,
    injury: r.injury,
    returnDate: r.return_date,
    updatedAt: r.updated_at,
    missing: r.missing,
  }));
}

export async function upsertSnapshot(
  db: D1Database,
  row: Omit<SnapshotRow, "missing">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO injury_snapshot (team, player_key, status, injury, return_date, updated_at, missing)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (team, player_key) DO UPDATE SET
         status = excluded.status, injury = excluded.injury, return_date = excluded.return_date,
         updated_at = excluded.updated_at, missing = 0`,
    )
    .bind(row.team, row.playerKey, row.status, row.injury, row.returnDate, row.updatedAt)
    .run();
}

export async function setSnapshotMissing(db: D1Database, team: string, playerKey: string, missing: number): Promise<void> {
  await db
    .prepare("UPDATE injury_snapshot SET missing = ? WHERE team = ? AND player_key = ?")
    .bind(missing, team, playerKey)
    .run();
}

export async function deleteSnapshot(db: D1Database, team: string, playerKey: string): Promise<void> {
  await db.prepare("DELETE FROM injury_snapshot WHERE team = ? AND player_key = ?").bind(team, playerKey).run();
}

// --- Episodes --------------------------------------------------------------

export async function findOpenEpisode(db: D1Database, team: string, playerKey: string): Promise<Episode | undefined> {
  const row = await db
    .prepare("SELECT * FROM injury_episodes WHERE team = ? AND player_key = ? AND closed_at IS NULL")
    .bind(team, playerKey)
    .first<EpisodeDbRow>();
  return row ? toEpisode(row) : undefined;
}

export async function getEpisode(db: D1Database, id: number): Promise<Episode | undefined> {
  const row = await db.prepare("SELECT * FROM injury_episodes WHERE id = ?").bind(id).first<EpisodeDbRow>();
  return row ? toEpisode(row) : undefined;
}

/** Open episodes for some teams (or every team), most serious first. */
export async function openEpisodes(db: D1Database, teams?: readonly string[]): Promise<Episode[]> {
  const filter = teams ? `AND team IN (${teams.map(() => "?").join(", ")})` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM injury_episodes WHERE closed_at IS NULL ${filter}
       ORDER BY team, CASE status WHEN 'ir' THEN 0 WHEN 'suspended' THEN 1 WHEN 'out' THEN 2 ELSE 3 END, player`,
    )
    .bind(...(teams ?? []))
    .all<EpisodeDbRow>();
  return results.map(toEpisode);
}

export async function insertEpisode(db: D1Database, e: Omit<Episode, "id" | "closedAt">): Promise<Episode> {
  const result = await db
    .prepare(
      `INSERT INTO injury_episodes
         (team, player_key, player, position, status, injury, return_date, note, first_source, reporter,
          thread_url, player_url, espn_confirmed, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.team,
      e.playerKey,
      e.player,
      e.position,
      e.status,
      e.injury,
      e.returnDate,
      e.note,
      e.firstSource,
      e.reporter,
      e.threadUrl,
      e.playerUrl,
      e.espnConfirmed ? 1 : 0,
      e.openedAt,
      e.updatedAt,
    )
    .run();
  return { ...e, id: Number(result.meta.last_row_id), closedAt: null };
}

export async function saveEpisode(db: D1Database, e: Episode): Promise<void> {
  await db
    .prepare(
      `UPDATE injury_episodes SET player = ?, position = ?, status = ?, injury = ?, return_date = ?, note = ?,
         reporter = ?, thread_url = ?, player_url = ?, espn_confirmed = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    )
    .bind(
      e.player,
      e.position,
      e.status,
      e.injury,
      e.returnDate,
      e.note,
      e.reporter,
      e.threadUrl,
      e.playerUrl,
      e.espnConfirmed ? 1 : 0,
      e.updatedAt,
      e.closedAt,
      e.id,
    )
    .run();
}

// --- Updates and posts -----------------------------------------------------

export async function insertUpdate(db: D1Database, u: Omit<InjuryUpdate, "id">): Promise<InjuryUpdate> {
  const result = await db
    .prepare("INSERT INTO injury_updates (episode_id, kind, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(u.episodeId, u.kind, u.fromStatus, u.toStatus, u.createdAt)
    .run();
  return { ...u, id: Number(result.meta.last_row_id) };
}

export async function hasReportedUpdate(db: D1Database, episodeId: number): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM injury_updates WHERE episode_id = ? AND kind = 'reported'")
      .bind(episodeId)
      .first()) !== null
  );
}

/** Updates not yet sent to every channel, created after `since`, oldest first. */
export async function pendingUpdates(db: D1Database, since: number): Promise<InjuryUpdate[]> {
  const { results } = await db
    .prepare("SELECT * FROM injury_updates WHERE done = 0 AND created_at >= ? ORDER BY id")
    .bind(since)
    .all<UpdateDbRow>();
  return results.map(toUpdate);
}

export async function markUpdateDone(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE injury_updates SET done = 1 WHERE id = ?").bind(id).run();
}

export async function postedChannelsForUpdate(db: D1Database, updateId: number): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT channel_id FROM injury_posts WHERE update_id = ?")
    .bind(updateId)
    .all<{ channel_id: string }>();
  return new Set(results.map((r) => r.channel_id));
}

export async function recordInjuryPost(
  db: D1Database,
  post: { updateId: number; channelId: string; messageId: string },
  now: number,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO injury_posts (update_id, channel_id, message_id, posted_at) VALUES (?, ?, ?, ?)")
    .bind(post.updateId, post.channelId, post.messageId, now)
    .run();
}

/** The first message about an episode in each channel that got one: what edits and replies point at. */
export async function rootMessages(db: D1Database, episodeId: number): Promise<{ channelId: string; messageId: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.channel_id, p.message_id FROM injury_posts p
       JOIN injury_updates u ON u.id = p.update_id
       WHERE u.episode_id = ? AND u.kind = 'reported'`,
    )
    .bind(episodeId)
    .all<{ channel_id: string; message_id: string }>();
  return results.map((r) => ({ channelId: r.channel_id, messageId: r.message_id }));
}

/** D1 batches send many statements in one round trip; keep each batch modest. */
const BATCH_SIZE = 50;

/**
 * First run: record everyone currently on ESPN's list (snapshot and an open
 * episode each) without announcing anything. Batched, so 100+ injuries cost a
 * handful of D1 calls rather than hundreds.
 */
export async function baselineInjuries(db: D1Database, reports: readonly InjuryReport[], now: number): Promise<void> {
  const statements = reports.flatMap((r) => [
    db
      .prepare(
        `INSERT OR REPLACE INTO injury_snapshot (team, player_key, status, injury, return_date, updated_at, missing)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(r.team, r.playerKey, r.status, r.injury ?? null, r.returnDate ?? null, r.updatedAt),
    // The partial unique index (one open episode per player) makes this a no-op if one exists.
    db
      .prepare(
        `INSERT OR IGNORE INTO injury_episodes
           (team, player_key, player, position, status, injury, return_date, note, first_source,
            player_url, espn_confirmed, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'espn', ?, 1, ?, ?)`,
      )
      .bind(r.team, r.playerKey, r.player, r.position ?? null, r.status, r.injury ?? null, r.returnDate ?? null, r.note ?? null, r.url ?? null, now, now),
  ]);
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}
