import { fetchRoster, type RosterPlayer } from "../sources/nhl";

/** Rosters change slowly; a day-old one is fine for matching names. */
const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The team's roster, from the D1 cache when it's fresh, otherwise from
 * NHL.com. If NHL.com is down, a stale cached roster beats none.
 */
export async function getRoster(db: D1Database, team: string, now: number): Promise<RosterPlayer[]> {
  const cached = await db
    .prepare("SELECT players, fetched_at FROM rosters WHERE team = ?")
    .bind(team)
    .first<{ players: string; fetched_at: number }>();
  if (cached && now - cached.fetched_at < ROSTER_TTL_MS) return JSON.parse(cached.players) as RosterPlayer[];
  try {
    const players = await fetchRoster(team);
    await db
      .prepare(
        `INSERT INTO rosters (team, players, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (team) DO UPDATE SET players = excluded.players, fetched_at = excluded.fetched_at`,
      )
      .bind(team, JSON.stringify(players), now)
      .run();
    return players;
  } catch (err) {
    if (cached) return JSON.parse(cached.players) as RosterPlayer[];
    throw err;
  }
}
